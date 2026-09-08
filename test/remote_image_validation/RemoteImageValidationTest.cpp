#include <gtest/gtest.h>

#include <array>
#include <cstdint>

#include "RemoteImageValidation.h"

namespace {

void writeLe16(std::array<uint8_t, 62>& bytes, const size_t offset, const uint16_t value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = value >> 8;
}

void writeLe32(std::array<uint8_t, 62>& bytes, const size_t offset, const uint32_t value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = value >> 24;
}

std::array<uint8_t, 62> oneBitHeader(const int32_t width = 528, const int32_t height = 792) {
  std::array<uint8_t, 62> bytes = {};
  bytes[0] = 'B';
  bytes[1] = 'M';
  writeLe32(bytes, 10, 62);
  writeLe32(bytes, 14, 40);
  writeLe32(bytes, 18, static_cast<uint32_t>(width));
  writeLe32(bytes, 22, static_cast<uint32_t>(height));
  writeLe16(bytes, 26, 1);
  writeLe16(bytes, 28, 1);
  writeLe32(bytes, 46, 2);
  return bytes;
}

uint64_t oneBitFileSize(const int32_t width, const int32_t height) {
  const uint64_t rowBytes = ((static_cast<uint64_t>(width) + 31) / 32) * 4;
  return 62 + rowBytes * height;
}

}  // namespace

TEST(RemoteImageUrl, AcceptsOnlyNonEmptyHttpsUrlsWithoutWhitespace) {
  EXPECT_TRUE(RemoteImageValidation::isHttpsUrl("https://example.com/dashboard.bmp"));
  EXPECT_TRUE(RemoteImageValidation::isHttpsUrl("HTTPS://example.com/a.bmp?token=123"));
  EXPECT_FALSE(RemoteImageValidation::isHttpsUrl("http://example.com/dashboard.bmp"));
  EXPECT_FALSE(RemoteImageValidation::isHttpsUrl("https://"));
  EXPECT_FALSE(RemoteImageValidation::isHttpsUrl("https://example.com/bad url.bmp"));
}

TEST(RemoteImageBmp, AcceptsCompleteX3OneBitDashboard) {
  auto header = oneBitHeader();
  const uint64_t fileSize = oneBitFileSize(528, 792);
  writeLe32(header, 2, static_cast<uint32_t>(fileSize));

  RemoteImageValidation::BmpInfo info;
  EXPECT_EQ(RemoteImageValidation::validateBmp(header.data(), header.size(), fileSize, &info),
            RemoteImageValidation::BmpError::Ok);
  EXPECT_EQ(info.width, 528);
  EXPECT_EQ(info.height, 792);
  EXPECT_EQ(info.bitsPerPixel, 1);
  EXPECT_EQ(info.requiredFileSize, fileSize);
}

TEST(RemoteImageBmp, AcceptsTopDownUncompressed24BitDashboard) {
  auto header = oneBitHeader(480, -800);
  writeLe16(header, 28, 24);
  writeLe32(header, 46, 0);
  writeLe32(header, 10, 54);
  const uint64_t fileSize = 54 + 480ull * 3ull * 800ull;
  writeLe32(header, 2, static_cast<uint32_t>(fileSize));

  RemoteImageValidation::BmpInfo info;
  EXPECT_EQ(RemoteImageValidation::validateBmp(header.data(), header.size(), fileSize, &info),
            RemoteImageValidation::BmpError::Ok);
  EXPECT_EQ(info.height, 800);
}

TEST(RemoteImageBmp, RejectsHtmlAndTruncatedImages) {
  std::array<uint8_t, 62> html = {};
  html[0] = '<';
  html[1] = '!';
  EXPECT_EQ(RemoteImageValidation::validateBmp(html.data(), html.size(), 1000),
            RemoteImageValidation::BmpError::NotBmp);

  auto header = oneBitHeader();
  EXPECT_EQ(RemoteImageValidation::validateBmp(header.data(), header.size(), 100),
            RemoteImageValidation::BmpError::TruncatedPixelData);
}

TEST(RemoteImageBmp, RejectsCompressedOrOversizedImages) {
  auto compressed = oneBitHeader();
  writeLe32(compressed, 30, 1);
  EXPECT_EQ(RemoteImageValidation::validateBmp(compressed.data(), compressed.size(), oneBitFileSize(528, 792)),
            RemoteImageValidation::BmpError::UnsupportedCompression);

  auto oversized = oneBitHeader(2049, 792);
  EXPECT_EQ(RemoteImageValidation::validateBmp(oversized.data(), oversized.size(), oneBitFileSize(2049, 792)),
            RemoteImageValidation::BmpError::ImageTooLarge);
}
