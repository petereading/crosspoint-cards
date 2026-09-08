#pragma once

#include "CrossPointSettings.h"
#include "activities/Activity.h"
#include "util/ButtonNavigator.h"

// "Lock Screens" folder: one entry per configured card slot. A card is just a
// BMP URL and a refresh interval, so this menu is a list of slots rather than a
// list of card kinds -- adding a card means filling in an empty slot, not
// changing the firmware.
class LockScreensActivity final : public Activity {
  ButtonNavigator buttonNavigator;
  int selectorIndex = 0;

  static constexpr int ITEM_COUNT = CrossPointSettings::LOCK_SCREEN_CARD_COUNT;

  // Menu label for a slot: the card name derived from its URL, or a prompt to
  // set one when the slot is still empty.
  std::string itemLabel(int index) const;

 public:
  explicit LockScreensActivity(GfxRenderer& renderer, MappedInputManager& mappedInput)
      : Activity("LockScreens", renderer, mappedInput) {}

  void onEnter() override;
  void loop() override;
  void render(RenderLock&&) override;
};
