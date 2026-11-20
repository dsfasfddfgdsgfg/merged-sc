TWEAK_NAME = SCMusicPlus

$(TWEAK_NAME)_FILES = SCMusicPlus.x SCMCNative.m
$(TWEAK_NAME)_CFLAGS = -fobjc-arc -I.
$(TWEAK_NAME)_FRAMEWORKS = UIKit WebKit AVFoundation MediaPlayer AudioToolbox

include $(THEOS)/makefiles/common.mk
include $(THEOS_MAKE_PATH)/tweak.mk

ifeq ($(THEOS_PACKAGE_SCHEME),rootless)
	export ARCHS = arm64 arm64e
	export TARGET = iphone:clang:16.5:15.0
else
	export ARCHS = armv7 armv7s arm64 arm64e
	export TARGET = iphone:clang:14.5:7.0
endif

INSTALL_TARGET_PROCESSES = com.soundcloud.TouchApp
