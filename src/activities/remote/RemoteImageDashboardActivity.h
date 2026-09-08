#pragma once

#include <string>

#include "CrossPointSettings.h"
#include "CrossPointState.h"
#include "activities/Activity.h"
#include "network/HttpDownloader.h"

// Generic externally-rendered dashboard. The device only owns transport,
// validation, display, and timed sleep; dashboard generation stays off-device.
class RemoteImageDashboardActivity final : public Activity {
 public:
  // slot indexes CrossPointSettings::lockScreenCardUrl. Every card is a URL and
  // an interval; nothing else distinguishes one from another.
  explicit RemoteImageDashboardActivity(GfxRenderer& renderer, MappedInputManager& mappedInput, uint8_t slot,
                                        bool autoRefresh = false)
      : Activity("RemoteImageDashboard", renderer, mappedInput), slot(slot), autoRefresh(autoRefresh) {
    buildCachePaths();
  }

  void onEnter() override;
  void onExit() override;
  void loop() override;
  void render(RenderLock&&) override;
  bool skipLoopDelay() override { return state == State::Connecting || state == State::Fetching; }
  bool preventAutoSleep() override { return autoRefresh || state != State::Failed; }

 private:
  enum class State { Connecting, Fetching, Showing, Failed };

  static constexpr unsigned long WIFI_TIMEOUT_MS = 45000;
  // A card is ~53 KB of BMP over verified TLS. The old budgets (25 s total,
  // 9 s first attempt, 3 s per socket read) left roughly five seconds of body
  // time once DNS, TCP, the TLS handshake and the server's first byte were
  // paid for, so the transfer only completed on a link sustaining ~10 KB/s and
  // was cut off mid-body otherwise -- the "HTTP 200, 6845 of 53000 bytes,
  // 25 s" failure. These give a slow link room to finish instead.
  static constexpr unsigned long FETCH_TOTAL_TIMEOUT_MS = 90000;
  static constexpr unsigned long FETCH_FIRST_ATTEMPT_MS = 60000;
  // Per socket read, not per transfer. HttpDownloader's own default is 60 s
  // because 15 s was found to kill slow servers; 3 s aborted the whole fetch
  // on any single chunk that arrived late.
  static constexpr unsigned long FETCH_OPERATION_TIMEOUT_MS = 20000;
  static constexpr unsigned long WIFI_RETRY_TIMEOUT_MS = 5000;
  // A card opened from the menu that failed retries sooner than its configured
  // interval, so a card left on screen recovers from a blip on its own.
  static constexpr unsigned long INTERACTIVE_RETRY_MS = 60000;

  const uint8_t slot;
  const bool autoRefresh;
  // Per-slot cache filenames, built once. These used to be a switch returning
  // string literals per card kind; with numbered slots they are just formatted.
  char imagePathBuf[40] = {};
  char tempPathBuf[40] = {};
  char backupPathBuf[40] = {};
  char titleBuf[32] = {};
  State state = State::Connecting;
  bool wifiUsed = false;
  bool cachedImageAvailable = false;
  bool powerInputArmed = false;
  bool powerExitRequested = false;
  // Back pressed while a fetch was in flight. The download is synchronous and
  // gpio.update() only runs between activity loop() calls, so a press during
  // one is invisible unless the transfer itself polls for it.
  bool backExitRequested = false;
  bool powerInterruptAttached = false;
  // True while this activity drove the connection itself and must therefore
  // poll WiFi.status() to notice it come up. The interactive first entry hands
  // that job to WifiSelectionActivity, whose callback moves the state on.
  bool pollingWifi = false;
  unsigned long cycleStartMs = 0;
  unsigned long wifiConnectStart = 0;
  // When the on-screen card is next due to refresh in place. Interactive only;
  // the unattended path sleeps between refreshes instead.
  unsigned long nextRefreshAt = 0;
  const char* errorMessage = nullptr;
  // Why the last fetch failed, in terms that separate the three faults the
  // single "Image download failed" string used to hide: a bad HTTP status, a
  // timeout, and a failure to write the temp file to SD.
  char failureDetail[48] = {};
  int lastHttpStatus = 0;
  size_t lastBytesReceived = 0;
  size_t lastExpectedBytes = 0;

  void buildCachePaths();
  void promptUrl();
  void beginUpdate();
  void startDirectWifiConnect();
  void runFetch();
  HttpDownloader::DownloadError downloadDashboardImage();
  bool reconnectWifiForRetry(unsigned long timeoutMs);
  void scheduleInteractiveRefresh(bool succeeded);
  void beginScheduledRefresh();
  void shutdownWifiForIdle();
  void startPowerLatch();
  void stopPowerLatch();
  bool powerLatchTriggered();
  void returnToUser();
  void goToSleepAndPoll();
  void exitDashboardMode();

  // The URL is used exactly as configured -- no route, device or orientation is
  // appended. Anything the image needs to know travels in the URL itself.
  std::string dashboardUrl() const { return SETTINGS.lockScreenCardUrl[slot]; }
  const char* configuredUrl() const { return SETTINGS.lockScreenCardUrl[slot]; }
  char* configuredUrlBuffer() const { return SETTINGS.lockScreenCardUrl[slot]; }
  size_t configuredUrlCapacity() const { return CrossPointSettings::LOCK_SCREEN_CARD_URL_LEN; }
  const char* imagePath() const { return imagePathBuf; }
  const char* tempPath() const { return tempPathBuf; }
  const char* backupPath() const { return backupPathBuf; }
  const char* title() const { return titleBuf; }
  const char* urlLabel() const;
  uint8_t refreshMinutes() const { return SETTINGS.cardRefreshMinutes(slot); }
  uint8_t activeDashboardMode() const { return CrossPointState::DASHBOARD_CARD_BASE + slot; }

  void recoverInterruptedSwap();
  bool validateImageFile(const char* path) const;
  bool promoteDownloadedImage();
  bool renderCachedImage() const;
  void renderDefaultSleepScreen() const;
  void renderMessage(const char* message) const;
};
