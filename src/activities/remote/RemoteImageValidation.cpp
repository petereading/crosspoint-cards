#include "RemoteImageValidation.h"

#include <algorithm>
#include <cctype>
#include <climits>

namespace RemoteImageValidation {
namespace {

uint16_t readLe16(const uint8_t* data) {
  return static_cast<uint16_t>(data[0]) | (static_cast<uint16_t>(data[1]) << 8);
}

uint32_t readLe32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) |
         (static_cast<uint32_t>(data[2]) << 16) | (static_cast<uint32_t>(data[3]) << 24);
}

bool hasHttpsPrefix(const std::string_view url) {
  constexpr std::string_view prefix = "https://";
  if (url.size() < prefix.size()) return false;
  for (size_t i = 0; i < prefix.size(); i++) {
    if (std::tolower(static_cast<unsigned char>(url[i])) != prefix[i]) return false;
  }
  return true;
}

}  // namespace

bool isHttpsUrl(const std::string_view url) {
  if (!hasHttpsPrefix(url)) return false;

  const size_t hostStart = url.find("//") + 2;
  const size_t hostEnd = url.find_first_of("/?#", hostStart);
  const size_t hostLength = (hostEnd == std::string_view::npos ? url.size() : hostEnd) - hostStart;
  if (hostLength == 0) return false;

  return std::none_of(url.begin(), url.end(), [](const char c) {
    return std::iscntrl(static_cast<unsigned char>(c)) || std::isspace(static_cast<unsigned char>(c));
  });
}

BmpError validateBmp(const uint8_t* header, const size_t headerSize, const uint64_t fileSize, BmpInfo* info) {
  constexpr size_t MIN_HEADER_SIZE = 54;
  constexpr int32_t MAX_IMAGE_WIDTH = 2048;
  constexpr int32_t MAX_IMAGE_HEIGHT = 3072;

  if (!header || headerSize < MIN_HEADER_SIZE || fileSize < MIN_HEADER_SIZE) return BmpError::HeaderTooShort;
  if (readLe16(header) != 0x4D42) return BmpError::NotBmp;

  const uint32_t declaredFileSize = readLe32(header + 2);
  const uint32_t pixelOffset = readLe32(header + 10);
  const uint32_t dibSize = readLe32(header + 14);
  if (dibSize < 40) return BmpError::DibTooSmall;

  const int32_t width = static_cast<int32_t>(readLe32(header + 18));
  const int32_t rawHeight = static_cast<int32_t>(readLe32(header + 22));
  if (width <= 0 || rawHeight == 0 || rawHeight == INT32_MIN) return BmpError::BadDimensions;
  const int32_t height = rawHeight < 0 ? -rawHeight : rawHeight;
  if (width > MAX_IMAGE_WIDTH || height > MAX_IMAGE_HEIGHT) return BmpError::ImageTooLarge;

  const uint16_t planes = readLe16(header + 26);
  const uint16_t bpp = readLe16(header + 28);
  const uint32_t compression = readLe32(header + 30);
  if (planes != 1) return BmpError::BadPlanes;
  if (!(bpp == 1 || bpp == 2 || bpp == 4 || bpp == 8 || bpp == 24 || bpp == 32)) {
    return BmpError::UnsupportedBpp;
  }
  if (!(compression == 0 || (bpp == 32 && compression == 3))) return BmpError::UnsupportedCompression;

  uint32_t paletteEntries = readLe32(header + 46);
  if (paletteEntries == 0 && bpp <= 8) paletteEntries = 1u << bpp;
  if (paletteEntries > 256) return BmpError::PaletteTooLarge;

  uint64_t minimumOffset = 14ull + dibSize;
  if (bpp <= 8) minimumOffset += static_cast<uint64_t>(paletteEntries) * 4ull;
  if (pixelOffset < minimumOffset || pixelOffset > fileSize) return BmpError::BadPixelOffset;

  const uint64_t rowBytes = ((static_cast<uint64_t>(width) * bpp + 31ull) / 32ull) * 4ull;
  const uint64_t requiredFileSize = static_cast<uint64_t>(pixelOffset) + rowBytes * height;
  if (requiredFileSize > fileSize) return BmpError::TruncatedPixelData;
  if (declaredFileSize != 0 && (declaredFileSize < requiredFileSize || declaredFileSize > fileSize)) {
    return BmpError::TruncatedPixelData;
  }

  if (info) {
    info->width = width;
    info->height = height;
    info->bitsPerPixel = bpp;
    info->pixelOffset = pixelOffset;
    info->requiredFileSize = requiredFileSize;
  }
  return BmpError::Ok;
}

const char* errorToString(const BmpError error) {
  switch (error) {
    case BmpError::Ok:
      return "Ok";
    case BmpError::HeaderTooShort:
      return "HeaderTooShort";
    case BmpError::NotBmp:
      return "NotBmp";
    case BmpError::DibTooSmall:
      return "DibTooSmall";
    case BmpError::BadDimensions:
      return "BadDimensions";
    case BmpError::ImageTooLarge:
      return "ImageTooLarge";
    case BmpError::BadPlanes:
      return "BadPlanes";
    case BmpError::UnsupportedBpp:
      return "UnsupportedBpp";
    case BmpError::UnsupportedCompression:
      return "UnsupportedCompression";
    case BmpError::PaletteTooLarge:
      return "PaletteTooLarge";
    case BmpError::BadPixelOffset:
      return "BadPixelOffset";
    case BmpError::TruncatedPixelData:
      return "TruncatedPixelData";
  }
  return "Unknown";
}

}  // namespace RemoteImageValidation
