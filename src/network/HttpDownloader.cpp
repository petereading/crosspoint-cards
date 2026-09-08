#include "HttpDownloader.h"

#include <Arduino.h>
#include <Logging.h>
#include <Memory.h>
#include <base64.h>
#include <esp_crt_bundle.h>
#include <esp_http_client.h>

#include <cstring>
#include <functional>
#include <string>

namespace {
// RX holds the response headers. A server that sends more logs HTTP_HEADER
// "Buffer length is small", but that is non-fatal: the headers we read
// (Location, Content-Length) come first and survive. What matters more here is
// contiguous heap, because mbedTLS needs a contiguous block per record at the
// same moment WiFi, the SD write and a full-screen refresh are all live -- the
// conditions under which a dashboard fetch was observed to stall mid-body with
// the largest free block down around 20 KB. These are the sizes CrossPoint 1.6
// ships, so they are proven against the same servers. TX only carries our GET;
// the body streams in READ_CHUNK pieces.
constexpr int HTTP_RX_BUF = 2048;
constexpr int HTTP_TX_BUF = 512;
// Per-socket-op timeout. Some OPDS download endpoints are slow to send headers
// (>15s) and chunked catalogs stall mid-body, so 15s killed them. 60s gives
// slow servers room. esp_http_client's timeout_ms is uint32, so unlike Arduino
// HTTPClient's uint16 setTimeout it doesn't silently truncate.
constexpr int HTTP_TIMEOUT_MS = 60000;
constexpr size_t READ_CHUNK = 1024;
// A caller that can cancel is only polled between reads, and a read does not
// return until it has filled its buffer. A kilobyte on a slow link is still
// long enough for a button tap to fall entirely between two polls, so
// cancellable transfers read in smaller pieces to stay responsive.
constexpr size_t CANCELLABLE_READ_CHUNK = 512;

struct Sink {
  std::function<bool(const uint8_t*, size_t)> write;  // returns false to abort the transfer
  HttpDownloader::ProgressCallback progress;
  HttpDownloader::CancelCallback cancelRequested;
  uint32_t operationTimeoutMs = HTTP_TIMEOUT_MS;
  uint32_t overallTimeoutMs = 0;
  unsigned long startedAtMs = 0;
  bool bypassCache = false;
  int* outHttpStatus = nullptr;
  size_t total = 0;
  size_t downloaded = 0;
};

bool interrupted(const Sink& sink, HttpDownloader::DownloadError* result) {
  if (sink.cancelRequested && sink.cancelRequested()) {
    *result = HttpDownloader::ABORTED;
    return true;
  }
  if (sink.overallTimeoutMs != 0 && millis() - sink.startedAtMs >= sink.overallTimeoutMs) {
    *result = HttpDownloader::TIMED_OUT;
    return true;
  }
  return false;
}

bool isRedirect(int status) {
  return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
}

// Streams a GET body through sink.write in READ_CHUNK pieces. Uses the manual
// open/fetch_headers/read path rather than esp_http_client_perform(): perform()
// pushes the whole body through an event callback and reports a chunked body
// that ends early as ESP_ERR_HTTP_INCOMPLETE_DATA, whereas the read loop streams
// large/slow files and surfaces a short read directly.
HttpDownloader::DownloadError runGet(const std::string& url, const std::string& username, const std::string& password,
                                     Sink& sink) {
  esp_http_client_config_t config = {};
  config.url = url.c_str();
  config.buffer_size = HTTP_RX_BUF;
  config.buffer_size_tx = HTTP_TX_BUF;
  config.timeout_ms = sink.operationTimeoutMs != 0 ? sink.operationTimeoutMs : HTTP_TIMEOUT_MS;
  // Verify HTTPS against the bundled CA roots. This build has esp-tls
  // CONFIG_ESP_TLS_INSECURE off, so an unverified TLS handshake can't be set
  // up at all; the model is public servers over verified https and local
  // servers over plain http (esp_http_client picks the transport from the URL
  // scheme, so http:// needs no cert config). The prior setInsecure() worked
  // only because Arduino's ssl_client drives mbedtls directly.
  config.crt_bundle_attach = esp_crt_bundle_attach;
  config.keep_alive_enable = true;

  esp_http_client_handle_t client = esp_http_client_init(&config);
  if (!client) {
    LOG_ERR("HTTP", "client init failed");
    return HttpDownloader::HTTP_ERROR;
  }

  esp_http_client_set_header(client, "User-Agent", "CrossPoint-ESP32-" CROSSPOINT_VERSION);
  if (sink.bypassCache) {
    esp_http_client_set_header(client, "Cache-Control", "no-cache, no-store, max-age=0");
    esp_http_client_set_header(client, "Pragma", "no-cache");
  }
  if (!username.empty() && !password.empty()) {
    // Preemptive Basic auth, like the prior addHeader; don't wait for a 401.
    const std::string credentials = username + ":" + password;
    const String header = "Basic " + base64::encode(credentials.c_str());
    esp_http_client_set_header(client, "Authorization", header.c_str());
  }

  // open()/read() does not auto-follow redirects (only perform() does), so step
  // 30x responses manually. OPDS download endpoints and the GitHub release CDN
  // both redirect.
  HttpDownloader::DownloadError stopResult;
  if (interrupted(sink, &stopResult)) {
    esp_http_client_cleanup(client);
    return stopResult;
  }

  esp_err_t err = esp_http_client_open(client, 0);
  if (err != ESP_OK) {
    LOG_ERR("HTTP", "open failed: %s", esp_err_to_name(err));
    esp_http_client_cleanup(client);
    return HttpDownloader::HTTP_ERROR;
  }
  int64_t contentLength = esp_http_client_fetch_headers(client);
  if (interrupted(sink, &stopResult)) {
    esp_http_client_cleanup(client);
    return stopResult;
  }
  int status = esp_http_client_get_status_code(client);
  for (int hop = 0; isRedirect(status) && hop < 5; ++hop) {
    if (interrupted(sink, &stopResult)) {
      esp_http_client_cleanup(client);
      return stopResult;
    }
    if (esp_http_client_set_redirection(client) != ESP_OK) break;
    err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
      LOG_ERR("HTTP", "redirect open failed: %s", esp_err_to_name(err));
      esp_http_client_cleanup(client);
      return HttpDownloader::HTTP_ERROR;
    }
    contentLength = esp_http_client_fetch_headers(client);
    if (interrupted(sink, &stopResult)) {
      esp_http_client_cleanup(client);
      return stopResult;
    }
    status = esp_http_client_get_status_code(client);
  }

  if (sink.outHttpStatus) *sink.outHttpStatus = status;

  if (status != 200) {
    LOG_ERR("HTTP", "unexpected status: %d", status);
    esp_http_client_cleanup(client);
    return HttpDownloader::HTTP_ERROR;
  }

  // fetch_headers returns 0 for a chunked response (no Content-Length); leave
  // total at 0 so progress stays silent and the size check is skipped.
  sink.total = contentLength > 0 ? static_cast<size_t>(contentLength) : 0;

  const size_t chunk = sink.cancelRequested ? CANCELLABLE_READ_CHUNK : READ_CHUNK;
  auto buf = makeUniqueNoThrow<char[]>(chunk);
  if (!buf) {
    LOG_ERR("HTTP", "OOM: %u byte read buffer", (unsigned)chunk);
    esp_http_client_cleanup(client);
    return HttpDownloader::HTTP_ERROR;
  }

  while (true) {
    if (interrupted(sink, &stopResult)) {
      esp_http_client_cleanup(client);
      return stopResult;
    }
    const int read = esp_http_client_read(client, buf.get(), chunk);
    if (read < 0) {
      LOG_ERR("HTTP", "read error after %zu bytes", sink.downloaded);
      esp_http_client_cleanup(client);
      return HttpDownloader::HTTP_ERROR;
    }
    if (read == 0) {
      if (esp_http_client_is_complete_data_received(client)) break;
      if (interrupted(sink, &stopResult)) {
        esp_http_client_cleanup(client);
        return stopResult;
      }
      LOG_ERR("HTTP", "read stalled after %zu bytes", sink.downloaded);
      esp_http_client_cleanup(client);
      return HttpDownloader::HTTP_ERROR;
    }
    if (!sink.write(reinterpret_cast<const uint8_t*>(buf.get()), read)) {
      esp_http_client_cleanup(client);
      return HttpDownloader::FILE_ERROR;
    }
    sink.downloaded += read;
    if (sink.progress && sink.total > 0) sink.progress(sink.downloaded, sink.total);
  }

  const bool complete = esp_http_client_is_complete_data_received(client);
  esp_http_client_cleanup(client);
  if (!complete) {
    LOG_ERR("HTTP", "incomplete: got %zu of %zu bytes", sink.downloaded, sink.total);
    return HttpDownloader::HTTP_ERROR;
  }
  return HttpDownloader::OK;
}
}  // namespace

bool HttpDownloader::fetchUrl(const std::string& url, Stream& outContent, const std::string& username,
                              const std::string& password) {
  LOG_DBG("HTTP", "Fetching: %s", url.c_str());
  Sink sink;
  sink.write = [&outContent](const uint8_t* data, size_t len) { return outContent.write(data, len) == len; };
  return runGet(url, username, password, sink) == OK;
}

bool HttpDownloader::fetchUrl(const std::string& url, std::string& outContent, const std::string& username,
                              const std::string& password) {
  LOG_DBG("HTTP", "Fetching: %s", url.c_str());
  outContent.clear();  // start clean; the sink appends, so don't carry prior content
  Sink sink;
  sink.write = [&outContent](const uint8_t* data, size_t len) {
    outContent.append(reinterpret_cast<const char*>(data), len);
    return true;
  };
  return runGet(url, username, password, sink) == OK;
}

bool HttpDownloader::fetchUrl(const std::string& url, const DataCallback& onData, const std::string& username,
                              const std::string& password) {
  LOG_DBG("HTTP", "Fetching: %s", url.c_str());
  Sink sink;
  sink.write = onData;
  return runGet(url, username, password, sink) == OK;
}

HttpDownloader::DownloadError HttpDownloader::downloadToFile(const std::string& url, const std::string& destPath,
                                                             ProgressCallback progress, bool* cancelFlag,
                                                             const std::string& username, const std::string& password) {
  DownloadOptions options;
  if (cancelFlag) options.cancelRequested = [cancelFlag]() { return *cancelFlag; };
  return downloadToFile(url, destPath, options, std::move(progress), username, password);
}

HttpDownloader::DownloadError HttpDownloader::downloadToFile(const std::string& url, const std::string& destPath,
                                                             const DownloadOptions& options, ProgressCallback progress,
                                                             const std::string& username, const std::string& password) {
  LOG_DBG("HTTP", "Downloading: %s -> %s", url.c_str(), destPath.c_str());

  if (Storage.exists(destPath.c_str())) {
    Storage.remove(destPath.c_str());
  }
  HalFile file;
  if (!Storage.openFileForWrite("HTTP", destPath.c_str(), file)) {
    LOG_ERR("HTTP", "Failed to open file for writing");
    return FILE_ERROR;
  }

  Sink sink;
  sink.progress = std::move(progress);
  sink.cancelRequested = options.cancelRequested;
  sink.operationTimeoutMs = options.operationTimeoutMs;
  sink.overallTimeoutMs = options.overallTimeoutMs;
  sink.startedAtMs = millis();
  sink.bypassCache = options.bypassCache;
  sink.outHttpStatus = options.outHttpStatus;
  sink.write = [&file](const uint8_t* data, size_t len) { return file.write(data, len) == len; };

  const DownloadError result = runGet(url, username, password, sink);
  if (options.outBytesReceived) *options.outBytesReceived = sink.downloaded;
  if (options.outExpectedBytes) *options.outExpectedBytes = sink.total;
  // Close before any remove() on the same path; DESTRUCTOR_CLOSES_FILE would
  // otherwise close only after the remove.
  file.close();

  if (result != OK) {
    Storage.remove(destPath.c_str());
    return result;
  }
  if (sink.downloaded == 0) {
    LOG_ERR("HTTP", "no data received");
    Storage.remove(destPath.c_str());
    return HTTP_ERROR;
  }
  LOG_DBG("HTTP", "Downloaded %zu bytes", sink.downloaded);
  return OK;
}
