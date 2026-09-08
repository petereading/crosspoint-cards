#pragma once

#include <cstdint>

// Timed deep sleep for polling dashboard modes (GitHub/Weather/Tempest, etc;
// defined in main.cpp). Unlike the normal sleep path, this keeps the battery
// latch engaged so the RTC timer can wake the device for the next poll. The
// panel keeps showing the dashboard while asleep. Does not return.
[[noreturn]] void enterDashboardSleep(uint32_t seconds);
