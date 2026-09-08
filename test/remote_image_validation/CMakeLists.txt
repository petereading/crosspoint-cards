add_executable(RemoteImageValidationTest
  RemoteImageValidationTest.cpp
  ${REPO_ROOT}/src/activities/remote/RemoteImageValidation.cpp
)

target_include_directories(RemoteImageValidationTest PRIVATE
  ${REPO_ROOT}/src/activities/remote
)

target_link_libraries(RemoteImageValidationTest PRIVATE
  crosspoint_test_common
  GTest::gtest_main
)

gtest_discover_tests(RemoteImageValidationTest)
