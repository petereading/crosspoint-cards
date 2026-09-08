#include "LockScreensActivity.h"

#include <GfxRenderer.h>
#include <I18n.h>

#include <cstdio>
#include <string>

#include "MappedInputManager.h"
#include "activities/ActivityManager.h"
#include "components/UITheme.h"
#include "fontIds.h"

void LockScreensActivity::onEnter() {
  Activity::onEnter();
  requestUpdate();
}

std::string LockScreensActivity::itemLabel(const int index) const {
  const char* url = SETTINGS.lockScreenCardUrl[index];
  char label[40];
  if (url[0] == '\0') {
    snprintf(label, sizeof(label), "%s %d - %s", tr(STR_LOCK_SCREEN_CARD), index + 1, tr(STR_LOCK_SCREEN_CARD_EMPTY));
    return label;
  }

  // Name the card after the last path segment of its URL, so
  // ".../weather.bmp?units=metric" reads as "Weather" with nothing to set up.
  std::string name = url;
  const size_t query = name.find_first_of("?#");
  if (query != std::string::npos) name.resize(query);
  const size_t lastSlash = name.rfind('/');
  name = lastSlash == std::string::npos ? std::string() : name.substr(lastSlash + 1);
  const size_t dot = name.rfind('.');
  if (dot != std::string::npos) name.resize(dot);
  if (name.empty()) {
    snprintf(label, sizeof(label), "%s %d", tr(STR_LOCK_SCREEN_CARD), index + 1);
    return label;
  }
  name[0] = static_cast<char>(toupper(static_cast<unsigned char>(name[0])));
  return name;
}

void LockScreensActivity::loop() {
  buttonNavigator.onNext([this] {
    selectorIndex = ButtonNavigator::nextIndex(selectorIndex, ITEM_COUNT);
    requestUpdate();
  });
  buttonNavigator.onPrevious([this] {
    selectorIndex = ButtonNavigator::previousIndex(selectorIndex, ITEM_COUNT);
    requestUpdate();
  });

  if (mappedInput.wasReleased(MappedInputManager::Button::Confirm)) {
    activityManager.goToLockScreenCard(static_cast<uint8_t>(selectorIndex));
  }

  if (mappedInput.wasPressed(MappedInputManager::Button::Back)) {
    finish();
  }
}

void LockScreensActivity::render(RenderLock&&) {
  const auto& metrics = UITheme::getInstance().getMetrics();
  const auto pageWidth = renderer.getScreenWidth();
  const auto pageHeight = renderer.getScreenHeight();

  renderer.clearScreen();
  GUI.drawHeader(renderer, Rect{0, metrics.topPadding, pageWidth, metrics.headerHeight}, tr(STR_LOCK_SCREENS));

  GUI.drawButtonMenu(
      renderer,
      Rect{0, metrics.topPadding + metrics.headerHeight + metrics.verticalSpacing, pageWidth,
           pageHeight -
               (metrics.topPadding + metrics.headerHeight + metrics.verticalSpacing + metrics.buttonHintsHeight)},
      ITEM_COUNT, selectorIndex, [this](int index) { return itemLabel(index); }, [](int) { return UIIcon::Image; });

  const auto labels = mappedInput.mapLabels(tr(STR_BACK), tr(STR_SELECT), tr(STR_DIR_UP), tr(STR_DIR_DOWN));
  GUI.drawButtonHints(renderer, labels.btn1, labels.btn2, labels.btn3, labels.btn4);

  renderer.displayBuffer();
}
