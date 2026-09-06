#include "RemoteImageDashboardActivity.h"

#include <Arduino.h>
#include <Bitmap.h>
#include <BoardConfig.h>
#include <GfxRenderer.h>
#include <HalGPIO.h>
#include <HalStorage.h>
#include <I18n.h>
#include <Logging.h>
#include <WiFi.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include "CrossPointSettings.h"
#include "CrossPointState.h"
#include "DashboardSleep.h"
#include "MappedInputManager.h"
#include "RemoteImageValidation.h"
#include "SilentRestart.h"
#include "WifiCredentialStore.h"
#include "activities/network/WifiSelectionActivity.h"
#include "activities/util/KeyboardEntryActivity.h"
#include "components/UITheme.h"
#include "fontIds.h"
#include "images/Logo120.h"
#include "network/HttpDownloader.h"

namespace {
volatile uint32_t remotePowerInterruptFired = 0;

void IRAM_ATTR remotePowerInterruptHandler() { remotePowerInterruptFired = 1; }
}  // namespace

// A card's display name comes from the last path segment of its URL, so
// ".../weather.bmp?units=metric" shows as "Weather" with nothing to configure.
// Falls back to the slot number when the URL has no usable segment.
void RemoteImageDashboardActivity::buildCachePaths() {
  snprintf(imagePathBuf, sizeof(imagePathBuf), "/.crosspoint/card%u-image.bmp", static_cast<unsigned>(slot + 1));
  snprintf(tempPathBuf, sizeof(tempPathBuf), "/.crosspoint/card%u-image.tmp", static_cast<unsigned>(slot + 1));
  snprintf(backupPathBuf, sizeof(backupPathBuf), "/.crosspoint/card%u-image.bak", static_cast<unsigned>(slot + 1));

  std::string url = SETTINGS.lockScreenCardUrl[slot];
  const size_t query = url.find_first_of("?#");
  if (query != std::string::npos) url.resize(query);
  const size_t lastSlash = url.rfind('/');
  std::string name = lastSlash == std::string::npos ? std::string() : url.substr(lastSlash + 1);
  const size_t dot = name.rfind('.');
  if (dot != std::string::npos) name.resize(dot);
  if (name.empty()) {
    snprintf(titleBuf, sizeof(titleBuf), "%s %u", tr(STR_LOCK_SCREEN_CARD), static_cast<unsigned>(slot + 1));
    return;
  }
  name[0] = static_cast<char>(toupper(static_cast<unsigned char>(name[0])));
  snprintf(titleBuf, sizeof(titleBuf), "%.*s", static_cast<int>(sizeof(titleBuf) - 1), name.c_str());
}

void RemoteImageDashboardActivity::onEnter() {
  Activity::onEnter();

  cycleStartMs = millis();
  powerInputArmed = false;
  powerExitRequested = false;
  if (autoRefresh) startPowerLatch();

  recoverInterruptedSwap();
  cachedImageAvailable = validateImageFile(imagePath());

  // Paint the last known-good card immediately rather than replacing whatever
  // was on screen with a blocking "Downloading image..." message -- entered
  // from the menu that meant staring at a message for the length of a fetch.
  // Wait for this first paint before starting HTTPS: otherwise its completion
  // can satisfy the later requestUpdateAndWait() for the downloaded image and
  // let the device sleep before that new image reaches the panel. The one case
  // that needs no paint is a timer wake, where the panel already retains the
  // cached card.
  if (cachedImageAvailable && (!autoRefresh || APP_STATE.activeDashboardMode != activeDashboardMode())) {
    requestUpdateAndWait();
  }

  if (configuredUrl()[0] == '\0') {
    if (autoRefresh) {
      state = State::Failed;
      errorMessage = tr(STR_REMOTE_IMAGE_HTTPS_REQUIRED);
      requestUpdate();
      return;
    }
    promptUrl();
    return;
  }

  if (!RemoteImageValidation::isHttpsUrl(dashboardUrl())) {
    state = State::Failed;
    errorMessage = tr(STR_REMOTE_IMAGE_HTTPS_REQUIRED);
    requestUpdate();
    return;
  }

  beginUpdate();
}

void RemoteImageDashboardActivity::onExit() {
  stopPowerLatch();
  Activity::onExit();
  if (wifiUsed && WiFi.getMode() != WIFI_MODE_NULL) {
    WiFi.disconnect(false);
    delay(30);
    silentRestart();
  }
}

void RemoteImageDashboardActivity::promptUrl() {
  char* urlBuffer = configuredUrlBuffer();
  startActivityForResult(std::make_unique<KeyboardEntryActivity>(renderer, mappedInput, urlLabel(), urlBuffer,
                                                                 configuredUrlCapacity() - 1, InputType::Url),
                         [this, urlBuffer](const ActivityResult& result) {
                           if (result.isCancelled) {
                             if (urlBuffer[0] == '\0') {
                               finish();
                             } else {
                               if (state == State::Showing) scheduleInteractiveRefresh(true);
                               requestUpdate();
                             }
                             return;
                           }

                           const auto& kb = std::get<KeyboardResult>(result.data);
                           if (kb.text.empty()) {
                             urlBuffer[0] = '\0';
                             SETTINGS.saveToFile();
                             finish();
                             return;
                           }
                           if (!RemoteImageValidation::isHttpsUrl(kb.text)) {
                             state = State::Failed;
                             errorMessage = tr(STR_REMOTE_IMAGE_HTTPS_REQUIRED);
                             requestUpdate();
                             return;
                           }

                           strncpy(urlBuffer, kb.text.c_str(), configuredUrlCapacity() - 1);
                           urlBuffer[configuredUrlCapacity() - 1] = '\0';
                           SETTINGS.saveToFile();
                           beginUpdate();
                         });
}

void RemoteImageDashboardActivity::beginUpdate() {
  state = State::Connecting;
  errorMessage = nullptr;
  nextRefreshAt = 0;

  if (WiFi.status() == WL_CONNECTED) {
    state = State::Fetching;
    if (!autoRefresh) requestUpdate();
    return;
  }

  wifiUsed = true;
  if (autoRefresh) {
    startDirectWifiConnect();
    return;
  }

  startActivityForResult(std::make_unique<WifiSelectionActivity>(renderer, mappedInput),
                         [this](const ActivityResult& result) {
                           if (result.isCancelled || WiFi.status() != WL_CONNECTED) {
                             finish();
                             return;
                           }
                           state = State::Fetching;
                           requestUpdate();
                         });
}

void RemoteImageDashboardActivity::startDirectWifiConnect() {
  {
    RenderLock lock(*this);
    WIFI_STORE.loadFromFile();
  }

  const std::string lastSsid = WIFI_STORE.getLastConnectedSsid();
  const WifiCredential* cred = lastSsid.empty() ? nullptr : WIFI_STORE.findCredential(lastSsid);
  if (!cred) {
    LOG_ERR("REMOTE", "No saved WiFi network for unattended refresh");
    state = State::Failed;
    errorMessage = tr(STR_DASHBOARD_WIFI_FAILED);
    return;
  }

  LOG_INF("REMOTE", "Connecting to %s", cred->ssid.c_str());
  pollingWifi = true;
  WiFi.mode(WIFI_STA);
  // The device returns to deep sleep immediately after the fetch, so modem
  // sleep saves little here and can add multi-second latency to short TLS
  // transfers on marginal links.
  WiFi.setSleep(false);
  WiFi.begin(cred->ssid.c_str(), cred->password.empty() ? nullptr : cred->password.c_str());
  wifiConnectStart = millis();
}

void RemoteImageDashboardActivity::loop() {
  if (autoRefresh) {
    // The press that entered the lock screen may still be held when this
    // activity starts. Do not interpret that same physical press as an exit;
    // arm only after it has first been released.
    if (!powerInputArmed) {
      if (!mappedInput.isPressed(MappedInputManager::Button::Power)) powerInputArmed = true;
    } else if (mappedInput.wasPressed(MappedInputManager::Button::Power)) {
      LOG_INF("REMOTE", "Power pressed during unattended refresh; returning to normal use");
      powerExitRequested = true;
    }

    if (powerLatchTriggered()) {
      returnToUser();
      return;
    }
  }

  switch (state) {
    case State::Connecting:
      if (!autoRefresh && mappedInput.wasPressed(MappedInputManager::Button::Back)) {
        shutdownWifiForIdle();
        exitDashboardMode();
        finish();
        return;
      }
      if (!pollingWifi) return;
      if (WiFi.status() == WL_CONNECTED) {
        pollingWifi = false;
        state = State::Fetching;
        return;
      }
      if (millis() - wifiConnectStart >= WIFI_TIMEOUT_MS) {
        LOG_ERR("REMOTE", "WiFi connect timed out");
        pollingWifi = false;
        state = State::Failed;
        errorMessage = tr(STR_DASHBOARD_WIFI_FAILED);
        if (!autoRefresh) {
          // Keep the card on screen and try again later instead of leaving it
          // stuck on an error until the user intervenes.
          shutdownWifiForIdle();
          scheduleInteractiveRefresh(false);
          requestUpdate();
          return;
        }
        requestUpdateAndWait();
        if (powerLatchTriggered()) {
          returnToUser();
          return;
        }
        goToSleepAndPoll();
      }
      return;

    case State::Fetching:
      // Only paint before fetching when there is nothing worth keeping on the
      // panel; otherwise this is a full refresh that redraws what is already
      // displayed.
      if (!autoRefresh && !cachedImageAvailable) requestUpdateAndWait();
      runFetch();
      return;

    case State::Showing:
    case State::Failed:
      break;
  }

  if (autoRefresh) {
    requestUpdateAndWait();
    if (powerLatchTriggered()) {
      returnToUser();
      return;
    }
    goToSleepAndPoll();
    return;
  }

  if (mappedInput.wasPressed(MappedInputManager::Button::Back)) {
    exitDashboardMode();
    finish();
    return;
  }
  if (mappedInput.wasPressed(MappedInputManager::Button::Confirm)) {
    nextRefreshAt = 0;
    promptUrl();
    return;
  }
  // A card opened from the menu stays on screen and refreshes itself in place
  // at its configured interval, with the radio off in between. It is meant to
  // be left displayed, so it must not sleep or exit on its own.
  if (nextRefreshAt != 0 && millis() >= nextRefreshAt) {
    nextRefreshAt = 0;
    beginScheduledRefresh();
  }
}

void RemoteImageDashboardActivity::runFetch() {
  Storage.mkdir("/.crosspoint");

  // Modem sleep parks the radio between beacons, which costs multiple seconds
  // on a short TLS transfer. The unattended path already disables it before
  // connecting; do the same when the connection came from the network picker.
  WiFi.setSleep(false);

  lastHttpStatus = 0;
  lastBytesReceived = 0;
  lastExpectedBytes = 0;
  const unsigned long fetchStartedAt = millis();
  LOG_INF("REMOTE", "Downloading %s -> %s", dashboardUrl().c_str(), tempPath());
  const auto downloadResult = downloadDashboardImage();
  if (downloadResult == HttpDownloader::ABORTED && autoRefresh && powerLatchTriggered()) {
    LOG_INF("REMOTE", "Dashboard download cancelled by power button");
    returnToUser();
    return;
  }
  if (downloadResult == HttpDownloader::ABORTED && !autoRefresh && backExitRequested) {
    LOG_INF("REMOTE", "Back pressed during fetch; leaving the card");
    shutdownWifiForIdle();
    exitDashboardMode();
    finish();
    return;
  }
  if (downloadResult != HttpDownloader::OK) {
    const unsigned long elapsedS = (millis() - fetchStartedAt + 500) / 1000;
    LOG_ERR("REMOTE", "Image download failed: %d (HTTP %d, %u bytes in %lu s)", static_cast<int>(downloadResult),
            lastHttpStatus, static_cast<unsigned>(lastBytesReceived), elapsedS);
    state = State::Failed;
    errorMessage = tr(STR_REMOTE_IMAGE_FETCH_FAILED);
    switch (downloadResult) {
      case HttpDownloader::FILE_ERROR:
        // Never reached the network: the temp file could not be written.
        snprintf(failureDetail, sizeof(failureDetail), "SD write failed %uB", static_cast<unsigned>(lastBytesReceived));
        break;
      case HttpDownloader::TIMED_OUT:
        // Report what the server said it would send. A stall that declares a
        // full body and delivers part of it is a truncated response; one that
        // declares nothing arrived without a Content-Length, which is a
        // different fault with a different fix.
        snprintf(failureDetail, sizeof(failureDetail), "timeout %u/%uB %lus", static_cast<unsigned>(lastBytesReceived),
                 static_cast<unsigned>(lastExpectedBytes), elapsedS);
        break;
      case HttpDownloader::ABORTED:
        snprintf(failureDetail, sizeof(failureDetail), "cancelled");
        break;
      default:
        if (lastHttpStatus == 200 && lastExpectedBytes > lastBytesReceived) {
          // The server answered and the body started arriving but stopped
          // short: a cut-off transfer, not a server or network error.
          snprintf(failureDetail, sizeof(failureDetail), "cut off %u/%uB %lus",
                   static_cast<unsigned>(lastBytesReceived), static_cast<unsigned>(lastExpectedBytes), elapsedS);
        } else if (lastHttpStatus > 0) {
          snprintf(failureDetail, sizeof(failureDetail), "HTTP %d %uB %lus", lastHttpStatus,
                   static_cast<unsigned>(lastBytesReceived), elapsedS);
        } else {
          // No status line at all: DNS, TCP or the TLS handshake.
          snprintf(failureDetail, sizeof(failureDetail), "no reply %uB %lus", static_cast<unsigned>(lastBytesReceived),
                   elapsedS);
        }
        break;
    }
  } else if (!validateImageFile(tempPath())) {
    Storage.remove(tempPath());
    state = State::Failed;
    errorMessage = tr(STR_REMOTE_IMAGE_INVALID);
    failureDetail[0] = '\0';
  } else if (!promoteDownloadedImage()) {
    Storage.remove(tempPath());
    state = State::Failed;
    errorMessage = tr(STR_REMOTE_IMAGE_FETCH_FAILED);
  } else {
    cachedImageAvailable = true;
    state = State::Showing;
  }

  if (autoRefresh && powerLatchTriggered()) {
    returnToUser();
    return;
  }

  requestUpdateAndWait();
  if (autoRefresh) {
    if (powerLatchTriggered()) {
      returnToUser();
      return;
    }
    goToSleepAndPoll();
    return;
  }

  // Interactive: drop the radio and wait out the interval on screen.
  shutdownWifiForIdle();
  scheduleInteractiveRefresh(state == State::Showing);
}

// Between refreshes the card is just a picture on an e-ink panel, so the radio
// has nothing to do and is the largest current draw on the board.
void RemoteImageDashboardActivity::shutdownWifiForIdle() {
  pollingWifi = false;
  if (WiFi.getMode() == WIFI_MODE_NULL) return;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
}

void RemoteImageDashboardActivity::scheduleInteractiveRefresh(bool succeeded) {
  const unsigned long intervalMs =
      succeeded ? std::max<unsigned long>(1u, refreshMinutes()) * 60000UL : INTERACTIVE_RETRY_MS;
  nextRefreshAt = millis() + intervalMs;
  // Each refresh brings WiFi and TLS up and down again inside one activity
  // lifetime, which the unattended path avoids by sleeping instead. Log the
  // heap so a card left on screen for hours shows whether that fragments.
  LOG_INF("REMOTE", "Card refresh in %lu s (heap %u, largest block %u)", intervalMs / 1000UL,
          static_cast<unsigned>(ESP.getFreeHeap()), static_cast<unsigned>(ESP.getMaxAllocHeap()));
}

// A scheduled refresh reuses the saved network directly. Going back through
// WifiSelectionActivity would put a network picker in front of the card every
// time its interval elapsed.
void RemoteImageDashboardActivity::beginScheduledRefresh() {
  state = State::Connecting;
  errorMessage = nullptr;
  wifiUsed = true;
  // Deliberately no repaint here: the card already on the panel stays there
  // while the radio comes up, rather than flashing a "Connecting" screen on
  // every interval. E-ink would make that a full 1-2 s refresh each time.

  if (WiFi.status() == WL_CONNECTED) {
    state = State::Fetching;
    return;
  }
  startDirectWifiConnect();
  if (state == State::Failed) {
    // No saved network to reconnect to; keep the card up and try again later.
    shutdownWifiForIdle();
    scheduleInteractiveRefresh(false);
    requestUpdate();
  }
}

HttpDownloader::DownloadError RemoteImageDashboardActivity::downloadDashboardImage() {
  const unsigned long fetchStartedAt = millis();
  const auto cancelled = [this]() {
    if (autoRefresh) return powerLatchTriggered();
    if (backExitRequested) return true;
    // HttpDownloader checks this between bounded socket operations, which is
    // the only chance to notice a button during a transfer that owns the loop.
    mappedInput.update();
    if (mappedInput.wasPressed(MappedInputManager::Button::Back)) backExitRequested = true;
    return backExitRequested;
  };
  const auto remainingBudget = [&]() -> unsigned long {
    const unsigned long elapsed = millis() - fetchStartedAt;
    return elapsed < FETCH_TOTAL_TIMEOUT_MS ? FETCH_TOTAL_TIMEOUT_MS - elapsed : 0;
  };
  const auto fetchOnce = [&](unsigned long budgetMs) {
    HttpDownloader::DownloadOptions options;
    options.operationTimeoutMs = std::min(FETCH_OPERATION_TIMEOUT_MS, budgetMs);
    options.overallTimeoutMs = budgetMs;
    options.bypassCache = true;
    options.cancelRequested = cancelled;
    options.outHttpStatus = &lastHttpStatus;
    options.outBytesReceived = &lastBytesReceived;
    options.outExpectedBytes = &lastExpectedBytes;
    return HttpDownloader::downloadToFile(dashboardUrl(), tempPath(), options);
  };

  const unsigned long firstBudget = std::min(FETCH_FIRST_ATTEMPT_MS, remainingBudget());
  auto result = fetchOnce(firstBudget);
  if (result == HttpDownloader::OK || result == HttpDownloader::ABORTED || cancelled()) return result;

  // A status line means DNS, TCP and TLS all worked, so the link is not what
  // failed -- the body was. Dropping WiFi and re-associating would spend the
  // remaining budget on a fresh handshake instead of on the transfer, so only
  // reconnect when the first attempt never got a reply at all.
  if (lastHttpStatus > 0) {
    const unsigned long directBudget = remainingBudget();
    if (directBudget == 0) return HttpDownloader::TIMED_OUT;
    LOG_INF("REMOTE", "First image fetch failed (%d) after HTTP %d; retrying on the same connection",
            static_cast<int>(result), lastHttpStatus);
    return fetchOnce(directBudget);
  }

  LOG_INF("REMOTE", "First image fetch failed (%d); reconnecting once", static_cast<int>(result));
  const unsigned long reconnectBudget = std::min(WIFI_RETRY_TIMEOUT_MS, remainingBudget());
  if (reconnectBudget == 0 || !reconnectWifiForRetry(reconnectBudget)) {
    return cancelled() ? HttpDownloader::ABORTED : result;
  }

  const unsigned long retryBudget = remainingBudget();
  if (retryBudget == 0) return HttpDownloader::TIMED_OUT;
  LOG_INF("REMOTE", "Retrying dashboard image fetch with %lu ms remaining", retryBudget);
  return fetchOnce(retryBudget);
}

bool RemoteImageDashboardActivity::reconnectWifiForRetry(unsigned long timeoutMs) {
  const std::string lastSsid = WIFI_STORE.getLastConnectedSsid();
  const WifiCredential* cred = lastSsid.empty() ? nullptr : WIFI_STORE.findCredential(lastSsid);
  if (!cred) return false;

  WiFi.disconnect(false);
  delay(50);
  if (powerLatchTriggered()) return false;
  WiFi.begin(cred->ssid.c_str(), cred->password.empty() ? nullptr : cred->password.c_str());

  const unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < timeoutMs) {
    if (powerLatchTriggered()) return false;
    delay(50);
  }
  return WiFi.status() == WL_CONNECTED;
}

void RemoteImageDashboardActivity::startPowerLatch() {
  if (!autoRefresh || powerInterruptAttached) return;

  const auto& input = BoardConfig::ACTIVE.input;
  if (input.power < 0) return;

  remotePowerInterruptFired = 0;
  const int interruptMode = input.powerActiveHigh ? RISING : FALLING;
  attachInterrupt(digitalPinToInterrupt(input.power), remotePowerInterruptHandler, interruptMode);
  powerInterruptAttached = true;
}

void RemoteImageDashboardActivity::stopPowerLatch() {
  if (!powerInterruptAttached) return;

  const auto& input = BoardConfig::ACTIVE.input;
  detachInterrupt(digitalPinToInterrupt(input.power));
  powerInterruptAttached = false;
  if (remotePowerInterruptFired != 0) powerExitRequested = true;
}

bool RemoteImageDashboardActivity::powerLatchTriggered() {
  if (remotePowerInterruptFired != 0) powerExitRequested = true;
  return powerExitRequested;
}

void RemoteImageDashboardActivity::returnToUser() {
  stopPowerLatch();
  if (Storage.exists(tempPath())) Storage.remove(tempPath());
  exitDashboardMode();

  // Match a normal power-button wake from dashboard sleep: return to the book
  // when sleep began in the reader, otherwise return home. The silent restart
  // also clears WiFi/TLS heap fragmentation before normal use resumes.
  if (APP_STATE.lastSleepFromReader && !APP_STATE.openEpubPath.empty()) {
    silentRestartToReader();
  } else {
    silentRestart();
  }
}

void RemoteImageDashboardActivity::goToSleepAndPoll() {
  stopPowerLatch();
  if (powerExitRequested) {
    returnToUser();
    return;
  }

  APP_STATE.activeDashboardMode = activeDashboardMode();
  APP_STATE.saveToFile();
  const uint32_t intervalS = refreshMinutes() * 60u;
  const uint32_t intervalMs = intervalS * 1000u;
  const uint32_t cycleElapsedMs = millis() - cycleStartMs;
  const uint32_t sleepMs = intervalMs == 0 ? 1000u : intervalMs - (cycleElapsedMs % intervalMs);
  const uint32_t sleepS = std::max<uint32_t>(1u, (sleepMs + 999u) / 1000u);
  LOG_INF("REMOTE", "Dashboard armed after %lu ms, sleeping for %u s", cycleElapsedMs, static_cast<unsigned>(sleepS));
  enterDashboardSleep(sleepS);
}

void RemoteImageDashboardActivity::exitDashboardMode() {
  if (APP_STATE.activeDashboardMode == activeDashboardMode()) {
    APP_STATE.activeDashboardMode = CrossPointState::DASHBOARD_NONE;
    APP_STATE.saveToFile();
  }
}

const char* RemoteImageDashboardActivity::urlLabel() const { return tr(STR_REMOTE_IMAGE_URL); }

void RemoteImageDashboardActivity::recoverInterruptedSwap() {
  if (!Storage.exists(imagePath()) && Storage.exists(backupPath())) {
    if (Storage.rename(backupPath(), imagePath())) {
      LOG_INF("REMOTE", "Recovered previous dashboard image after interrupted update");
    }
  } else if (Storage.exists(imagePath()) && Storage.exists(backupPath())) {
    Storage.remove(backupPath());
  }
  if (Storage.exists(tempPath())) Storage.remove(tempPath());
  // Caches from the named-card builds cannot map onto numbered slots, and a
  // card repopulates itself on its first refresh, so drop them rather than
  // guess which slot they belonged to.
  for (const char* stale :
       {"/.crosspoint/remote-image.bmp", "/.crosspoint/remote-image.tmp", "/.crosspoint/remote-image.bak",
        "/.crosspoint/clock-image.bmp", "/.crosspoint/weather-image.bmp", "/.crosspoint/custom-image.bmp"}) {
    if (Storage.exists(stale)) Storage.remove(stale);
  }
}

bool RemoteImageDashboardActivity::validateImageFile(const char* path) const {
  HalFile file;
  if (!Storage.openFileForRead("REMOTE", path, file)) return false;

  std::array<uint8_t, 54> header = {};
  const uint64_t fileSize = file.fileSize64();
  const int bytesRead = file.read(header.data(), header.size());
  file.close();
  if (bytesRead != static_cast<int>(header.size())) return false;

  RemoteImageValidation::BmpInfo info;
  const auto result = RemoteImageValidation::validateBmp(header.data(), header.size(), fileSize, &info);
  if (result != RemoteImageValidation::BmpError::Ok) {
    LOG_ERR("REMOTE", "BMP validation failed: %s", RemoteImageValidation::errorToString(result));
    return false;
  }

  HalFile bitmapFile;
  if (!Storage.openFileForRead("REMOTE", path, bitmapFile)) return false;
  Bitmap bitmap(bitmapFile, true);
  const auto bitmapResult = bitmap.parseHeaders();
  bitmapFile.close();
  if (bitmapResult != BmpReaderError::Ok) {
    LOG_ERR("REMOTE", "BMP renderer rejected image: %s", Bitmap::errorToString(bitmapResult));
    return false;
  }

  LOG_INF("REMOTE", "Validated %ldx%ld %u-bpp BMP", static_cast<long>(info.width), static_cast<long>(info.height),
          static_cast<unsigned>(info.bitsPerPixel));
  return true;
}

bool RemoteImageDashboardActivity::promoteDownloadedImage() {
  if (Storage.exists(backupPath()) && !Storage.remove(backupPath())) return false;

  const bool hadPrevious = Storage.exists(imagePath());
  if (hadPrevious && !Storage.rename(imagePath(), backupPath())) {
    LOG_ERR("REMOTE", "Could not stage previous dashboard image");
    return false;
  }

  if (Storage.rename(tempPath(), imagePath())) {
    if (hadPrevious) Storage.remove(backupPath());
    return true;
  }

  LOG_ERR("REMOTE", "Could not promote downloaded dashboard image");
  if (hadPrevious && !Storage.rename(backupPath(), imagePath())) {
    LOG_ERR("REMOTE", "Could not restore previous dashboard image");
  }
  return false;
}

void RemoteImageDashboardActivity::render(RenderLock&&) {
  switch (state) {
    case State::Connecting:
    case State::Fetching:
      // Leave the last known-good card visible while WiFi and HTTPS run,
      // however this activity was entered. Replacing it with an updating
      // screen costs a full e-ink refresh and, on a card left on display,
      // means the panel spends most of each interval showing a message
      // instead of the card. Only first use, with nothing cached, needs it.
      if (cachedImageAvailable && renderCachedImage()) break;
      if (autoRefresh) {
        renderDefaultSleepScreen();
      } else {
        renderMessage(tr(STR_REMOTE_IMAGE_UPDATING));
      }
      break;
    case State::Failed:
      if (!cachedImageAvailable || !renderCachedImage()) {
        if (autoRefresh) {
          renderDefaultSleepScreen();
        } else {
          renderMessage(errorMessage ? errorMessage : tr(STR_REMOTE_IMAGE_FETCH_FAILED));
        }
      }
      break;
    case State::Showing:
      if (!renderCachedImage()) {
        if (autoRefresh)
          renderDefaultSleepScreen();
        else
          renderMessage(tr(STR_REMOTE_IMAGE_INVALID));
      }
      break;
  }
}

bool RemoteImageDashboardActivity::renderCachedImage() const {
  HalFile file;
  if (!Storage.openFileForRead("REMOTE", imagePath(), file)) return false;

  Bitmap bitmap(file, true);
  if (bitmap.parseHeaders() != BmpReaderError::Ok) {
    file.close();
    return false;
  }

  const auto originalOrientation = renderer.getOrientation();
  renderer.setOrientation(bitmap.getHeight() >= bitmap.getWidth()
                              ? GfxRenderer::Orientation::Portrait
                              : GfxRenderer::Orientation::LandscapeCounterClockwise);
  const int pageWidth = renderer.getScreenWidth();
  const int pageHeight = renderer.getScreenHeight();
  const float scale = std::min(
      {1.0f, static_cast<float>(pageWidth) / bitmap.getWidth(), static_cast<float>(pageHeight) / bitmap.getHeight()});
  const int renderedWidth = static_cast<int>(std::floor(bitmap.getWidth() * scale));
  const int renderedHeight = static_cast<int>(std::floor(bitmap.getHeight() * scale));
  const int x = (pageWidth - renderedWidth) / 2;
  const int y = (pageHeight - renderedHeight) / 2;

  renderer.clearScreen();
  renderer.drawBitmap(bitmap, x, y, pageWidth, pageHeight);
  renderer.displayBuffer(HalDisplay::FULL_REFRESH);
  renderer.setOrientation(originalOrientation);
  file.close();
  return true;
}

void RemoteImageDashboardActivity::renderDefaultSleepScreen() const {
  const auto pageWidth = renderer.getScreenWidth();
  const auto pageHeight = renderer.getScreenHeight();
  renderer.clearScreen();
  renderer.drawImage(Logo120, (pageWidth - 120) / 2, (pageHeight - 120) / 2, 120, 120);
  renderer.drawCenteredText(UI_10_FONT_ID, pageHeight / 2 + 70, tr(STR_CROSSPOINT), true, EpdFontFamily::BOLD);
  renderer.drawCenteredText(SMALL_FONT_ID, pageHeight / 2 + 95, tr(STR_SLEEPING));
  renderer.invertScreen();
  renderer.displayBuffer(HalDisplay::FULL_REFRESH);
}

void RemoteImageDashboardActivity::renderMessage(const char* message) const {
  const int pageHeight = renderer.getScreenHeight();
  renderer.clearScreen();
  renderer.drawCenteredText(UI_12_FONT_ID, pageHeight / 2 - 30, title(), true, EpdFontFamily::BOLD);
  renderer.drawCenteredText(UI_10_FONT_ID, pageHeight / 2 + 5, message);

  // A failure that names only "Image download failed" cannot be acted on: show
  // which of the three faults it was, and the URL actually requested, so a
  // wrong stored URL is visible on the device rather than inferred.
  if (state == State::Failed && failureDetail[0] != '\0') {
    renderer.drawCenteredText(SMALL_FONT_ID, pageHeight / 2 + 30, failureDetail);
    const std::string url = dashboardUrl();
    // The panel fits roughly 60 characters of the small font; the tail carries
    // the route and query, which is the part that varies per card.
    constexpr size_t URL_TAIL = 58;
    const std::string tail = url.size() > URL_TAIL ? url.substr(url.size() - URL_TAIL) : url;
    renderer.drawCenteredText(SMALL_FONT_ID, pageHeight / 2 + 48, tail.c_str());
  }

  if (!autoRefresh && state == State::Failed) {
    const auto labels = mappedInput.mapLabels(tr(STR_BACK), tr(STR_REMOTE_IMAGE_CHANGE_URL), "", "");
    GUI.drawButtonHints(renderer, labels.btn1, labels.btn2, labels.btn3, labels.btn4);
  }
  renderer.displayBuffer();
}
