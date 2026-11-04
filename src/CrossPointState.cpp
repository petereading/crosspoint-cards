#include "CrossPointState.h"

namespace {

void getLCG(uint32_t packedState, uint32_t packedCount, uint32_t& seed, uint32_t& state, uint16_t& indexesLeft,
            uint16_t& indexesTotal) {
  indexesLeft = packedCount >> 16;
  indexesTotal = packedCount & 0xffff;
  seed = packedState >> 16;
  state = packedState & 0xffff;
}

void setLCG(uint32_t& packedState, uint32_t& packedCount, uint32_t seedVal, uint32_t stateVal, uint16_t indexesLeftVal,
            uint16_t indexesTotalVal) {
  packedCount = (static_cast<uint32_t>(indexesLeftVal) << 16) | indexesTotalVal;
  packedState = (seedVal << 16) | (stateVal & 0xffff);
}

}  // namespace

void CrossPointState::getSleepLCG(uint32_t& seed, uint32_t& state, uint16_t& indexesLeft,
                                  uint16_t& indexesTotal) const {
  getLCG(sleepLcgState, sleepLcgCount, seed, state, indexesLeft, indexesTotal);
}

void CrossPointState::getSleepOverlayLCG(uint32_t& seed, uint32_t& state, uint16_t& indexesLeft,
                                         uint16_t& indexesTotal) const {
  getLCG(sleepOverlayLcgState, sleepOverlayLcgCount, seed, state, indexesLeft, indexesTotal);
}

void CrossPointState::setSleepLCG(uint32_t seed, uint32_t state, uint16_t indexesLeft, uint16_t indexesTotal) {
  setLCG(sleepLcgState, sleepLcgCount, seed, state, indexesLeft, indexesTotal);
}

void CrossPointState::setSleepOverlayLCG(uint32_t seed, uint32_t state, uint16_t indexesLeft, uint16_t indexesTotal) {
  setLCG(sleepOverlayLcgState, sleepOverlayLcgCount, seed, state, indexesLeft, indexesTotal);
}

void CrossPointState::toJson(JsonDocument& doc) const {
  doc["openEpubPath"] = openEpubPath;
  doc["sleepLcgCount"] = sleepLcgCount;
  doc["sleepLcgState"] = sleepLcgState;
  doc["sleepOverlayLcgCount"] = sleepOverlayLcgCount;
  doc["sleepOverlayLcgState"] = sleepOverlayLcgState;
  doc["readerActivityLoadCount"] = readerActivityLoadCount;
  doc["lastSleepFromReader"] = lastSleepFromReader;
  // A cycling card arms its wake with a deep sleep, and that wake is a chip
  // reset: without this the mode is gone by the time boot looks for it, and
  // the device lands on the home screen instead of the card.
  doc["activeDashboardMode"] = activeDashboardMode;
  doc["showBootScreen"] = showBootScreen;
}

bool CrossPointState::fromJson(JsonVariantConst doc) {
  openEpubPath = doc["openEpubPath"] | "";

  sleepLcgCount = doc["sleepLcgCount"] | static_cast<uint32_t>(0);
  sleepLcgState = doc["sleepLcgState"] | static_cast<uint32_t>(0);

  sleepOverlayLcgCount = doc["sleepOverlayLcgCount"] | static_cast<uint32_t>(0);
  sleepOverlayLcgState = doc["sleepOverlayLcgState"] | static_cast<uint32_t>(0);

  readerActivityLoadCount = doc["readerActivityLoadCount"] | static_cast<uint8_t>(0);
  lastSleepFromReader = doc["lastSleepFromReader"] | false;
  activeDashboardMode = doc["activeDashboardMode"] | static_cast<uint8_t>(DASHBOARD_NONE);
  // A slot removed since the file was written must not keep the device
  // cycling a card that no longer exists.
  if (activeDashboardMode >= DASHBOARD_CARD_END) activeDashboardMode = DASHBOARD_NONE;
  showBootScreen = doc["showBootScreen"] | true;
  return true;
}
