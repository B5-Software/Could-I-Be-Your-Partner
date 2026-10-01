/* SPDX-License-Identifier: GPL-3.0-or-later */
// Node-API keeps this bridge independent of Electron's V8 ABI. It runs inside
// the signed application process, so AX and CG events share one TCC identity.
#include <node_api.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <chrono>
#include <string>
#include <initializer_list>
#include <unistd.h>

static NSDictionary *failure(NSString *code, NSString *message) {
  return @{ @"ok": @NO, @"code": code, @"error": message };
}
static id attr(AXUIElementRef element, CFStringRef key) {
  CFTypeRef result = nullptr;
  if (AXUIElementCopyAttributeValue(element, key, &result) != kAXErrorSuccess) return nil;
  return CFBridgingRelease(result);
}
static NSString *text(id value) {
  return [value isKindOfClass:[NSString class]] ? value : @"";
}
static void post(CGEventRef event) {
  if (!event) @throw [NSException exceptionWithName:@"CGEvent" reason:@"Could not create input event" userInfo:nil];
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}
static CGPoint cursor() {
  CGEventRef event = CGEventCreate(nullptr);
  if (!event) return CGPointZero;
  CGPoint result = CGEventGetLocation(event);
  CFRelease(event); return result;
}

static NSDictionary *tree(pid_t pid = 0) {
  if (!AXIsProcessTrusted()) return failure(@"accessibility_required", @"Enable Accessibility for this application.");
  NSRunningApplication *app = pid ? [NSRunningApplication runningApplicationWithProcessIdentifier:pid] : [[NSWorkspace sharedWorkspace] frontmostApplication];
  if (!app) return failure(@"ui_unavailable", @"No foreground application");
  AXUIElementRef root = AXUIElementCreateApplication(app.processIdentifier);
  AXUIElementSetMessagingTimeout(root, 0.2f);
  NSMutableArray *elements = [NSMutableArray array];
  NSMutableSet *seen = [NSMutableSet set];
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(4);
  BOOL truncated = NO;
  // A recursive C++ lambda bounds the entire tree, not each sibling list.
  auto walk = [&](auto &&self, AXUIElementRef el, int depth) -> void {
    if (elements.count >= 300 || std::chrono::steady_clock::now() >= deadline) { truncated = YES; return; }
    if (depth > 15 || [seen containsObject:(__bridge id)el]) return;
    [seen addObject:(__bridge id)el];
    AXUIElementSetMessagingTimeout(el, 0.2f);
    NSString *role = text(attr(el, kAXRoleAttribute));
    NSString *title = text(attr(el, kAXTitleAttribute));
    if (!title.length) title = text(attr(el, kAXDescriptionAttribute));
    if (!title.length) title = text(attr(el, kAXValueAttribute));
    id position = attr(el, kAXPositionAttribute), size = attr(el, kAXSizeAttribute);
    CGPoint point = CGPointZero; CGSize dimensions = CGSizeZero;
    id bbox = [NSNull null];
    if (position && size && CFGetTypeID((__bridge CFTypeRef)position) == AXValueGetTypeID()
        && CFGetTypeID((__bridge CFTypeRef)size) == AXValueGetTypeID()
        && AXValueGetValue((__bridge AXValueRef)position, kAXValueCGPointType, &point)
        && AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &dimensions)) {
      bbox = @{ @"x": @(point.x), @"y": @(point.y), @"w": @(dimensions.width), @"h": @(dimensions.height),
        @"cx": @(point.x + dimensions.width / 2), @"cy": @(point.y + dimensions.height / 2) };
    }
    CFArrayRef actionNames = nullptr;
    NSMutableArray *actions = [NSMutableArray array];
    if (AXUIElementCopyActionNames(el, &actionNames) == kAXErrorSuccess) {
      for (NSString *action in (__bridge NSArray *)actionNames) [actions addObject:action];
      CFRelease(actionNames);
    }
    [elements addObject:@{ @"index": @(elements.count), @"depth": @(depth), @"type": role,
      @"name": title, @"value": text(attr(el, kAXValueAttribute)), @"bbox": bbox, @"actions": actions }];
    id children = attr(el, kAXChildrenAttribute);
    if ([children isKindOfClass:[NSArray class]]) for (id child in children) {
      if (truncated) break;
      if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID()) self(self, (__bridge AXUIElementRef)child, depth + 1);
    }
  };
  id window = attr(root, kAXFocusedWindowAttribute);
  walk(walk, window ? (__bridge AXUIElementRef)window : root, 0);
  CFRelease(root);
  return @{ @"ok": @YES, @"count": @(elements.count), @"elements": elements,
    @"truncated": @(truncated), @"coordinateSpace": @"desktop-points", @"application": app.localizedName ?: @"" };
}

static NSDictionary *perform(NSString *action, NSDictionary *args) {
  if ([action isEqualToString:@"permissions"]) {
    return @{ @"ok": @YES, @"accessibility": @(AXIsProcessTrusted()),
      @"postEvents": @(CGPreflightPostEventAccess()), @"screen": @(CGPreflightScreenCaptureAccess()) };
  }
  if ([action isEqualToString:@"requestPermission"]) {
    if ([args[@"permission"] isEqualToString:@"accessibility"]) {
      NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
      AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
    } else if ([args[@"permission"] isEqualToString:@"screen"]) CGRequestScreenCaptureAccess();
    else return failure(@"invalid_permission", @"Unknown permission");
    return perform(@"permissions", @{});
  }
  if ([action isEqualToString:@"tree"]) return tree();
  if ([action isEqualToString:@"cursor"]) {
    CGPoint point = cursor(); return @{ @"ok": @YES, @"x": @(point.x), @"y": @(point.y) };
  }
  // Returning success after an event silently discarded by macOS was the old bug.
  if (!AXIsProcessTrusted() || !CGPreflightPostEventAccess())
    return failure(@"accessibility_required", @"Enable Accessibility for this application, then retry. Restart the application if macOS has not refreshed the grant.");
  if ([action isEqualToString:@"move"]) {
    CGPoint point = CGPointMake([args[@"x"] doubleValue], [args[@"y"] doubleValue]);
    CGEventType kind = [args[@"drag"] boolValue] ? kCGEventLeftMouseDragged : kCGEventMouseMoved;
    post(CGEventCreateMouseEvent(nullptr, kind, point, kCGMouseButtonLeft));
  } else if ([action isEqualToString:@"button"]) {
    BOOL down = [args[@"down"] boolValue];
    NSInteger button = [args[@"button"] integerValue];
    CGEventType kind = button == 1 ? (down ? kCGEventRightMouseDown : kCGEventRightMouseUp)
      : button == 2 ? (down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp)
      : (down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp);
    CGEventRef event = CGEventCreateMouseEvent(nullptr, kind, cursor(), (CGMouseButton)button);
    if (event) CGEventSetIntegerValueField(event, kCGMouseEventClickState, MAX(1, [args[@"count"] intValue]));
    post(event);
  } else if ([action isEqualToString:@"scroll"]) {
    post(CGEventCreateScrollWheelEvent(nullptr, kCGScrollEventUnitLine, 2,
      [args[@"vertical"] intValue], [args[@"horizontal"] intValue]));
  } else if ([action isEqualToString:@"key"]) {
    CGEventRef event = CGEventCreateKeyboardEvent(nullptr, (CGKeyCode)[args[@"code"] intValue], [args[@"down"] boolValue]);
    if (event) CGEventSetFlags(event, (CGEventFlags)[args[@"flags"] unsignedLongLongValue]);
    post(event);
  } else if ([action isEqualToString:@"type"]) {
    NSString *value = text(args[@"text"]);
    if (value.length > 100000) return failure(@"invalid_text", @"Text exceeds 100000 UTF-16 units");
    for (NSUInteger offset = 0; offset < value.length;) {
      NSUInteger length = MIN(20, value.length - offset);
      if (offset + length < value.length && CFStringIsSurrogateHighCharacter([value characterAtIndex:offset + length - 1])) length--;
      UniChar characters[20]; [value getCharacters:characters range:NSMakeRange(offset, length)];
      for (BOOL down : { YES, NO }) {
        CGEventRef event = CGEventCreateKeyboardEvent(nullptr, 0, down);
        if (event) { CGEventKeyboardSetUnicodeString(event, length, characters); CGEventSetFlags(event, 0); }
        post(event);
      }
      offset += length; usleep(10000);
    }
  } else return failure(@"invalid_action", @"Unknown native action");
  return @{ @"ok": @YES };
}

static std::string argument(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return "";
  std::string result(length + 1, '\0');
  napi_get_value_string_utf8(env, value, result.data(), result.size(), &length);
  result.resize(length); return result;
}
static napi_value invoke(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2) { napi_throw_type_error(env, nullptr, "action and JSON arguments required"); return nullptr; }
  @autoreleasepool {
    std::string action = argument(env, args[0]), json = argument(env, args[1]);
    NSString *name = [NSString stringWithUTF8String:action.c_str()];
    NSData *input = [NSData dataWithBytes:json.data() length:json.size()];
    id payload = [NSJSONSerialization JSONObjectWithData:input options:0 error:nullptr];
    if (![payload isKindOfClass:[NSDictionary class]]) { napi_throw_type_error(env, nullptr, "JSON object required"); return nullptr; }
    NSDictionary *result;
    @try { result = perform(name, payload); }
    @catch (NSException *error) { result = failure(@"native_error", error.reason ?: @"Native control failed"); }
    NSData *output = [NSJSONSerialization dataWithJSONObject:result options:0 error:nullptr];
    if (!output) { napi_throw_error(env, nullptr, "Native result serialization failed"); return nullptr; }
    napi_value value; napi_create_string_utf8(env, (const char *)output.bytes, output.length, &value); return value;
  }
}

struct TreeWork {
  napi_async_work work;
  napi_deferred deferred;
  pid_t pid;
  std::string output;
};
static void executeTree(napi_env env, void *data) {
  auto *job = static_cast<TreeWork *>(data);
  @autoreleasepool {
    NSDictionary *result;
    @try { result = tree(job->pid); }
    @catch (NSException *error) { result = failure(@"ui_unavailable", error.reason ?: @"AX tree failed"); }
    NSData *output = [NSJSONSerialization dataWithJSONObject:result options:0 error:nullptr];
    if (output) job->output.assign((const char *)output.bytes, output.length);
    else job->output = "{\"ok\":false,\"error\":\"AX result serialization failed\"}";
  }
}
static void completeTree(napi_env env, napi_status status, void *data) {
  auto *job = static_cast<TreeWork *>(data);
  napi_value result;
  if (status == napi_ok) {
    napi_create_string_utf8(env, job->output.data(), job->output.size(), &result);
    napi_resolve_deferred(env, job->deferred, result);
  } else {
    napi_value message; napi_create_string_utf8(env, "AX tree cancelled", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &result); napi_reject_deferred(env, job->deferred, result);
  }
  napi_delete_async_work(env, job->work); delete job;
}
static napi_value getUITree(napi_env env, napi_callback_info info) {
  auto *job = new TreeWork();
  job->pid = [[NSWorkspace sharedWorkspace] frontmostApplication].processIdentifier;
  napi_value promise, resource;
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "cibyp:AXTree", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_async_work(env, nullptr, resource, executeTree, completeTree, job, &job->work) != napi_ok) {
    delete job; napi_throw_error(env, nullptr, "Could not create AX worker"); return nullptr;
  }
  if (napi_queue_async_work(env, job->work) != napi_ok) {
    napi_delete_async_work(env, job->work); delete job;
    napi_throw_error(env, nullptr, "Could not queue AX worker"); return nullptr;
  }
  return promise;
}
NAPI_MODULE_INIT() {
  napi_value method; napi_create_function(env, "invoke", NAPI_AUTO_LENGTH, invoke, nullptr, &method);
  napi_set_named_property(env, exports, "invoke", method);
  napi_create_function(env, "getUITree", NAPI_AUTO_LENGTH, getUITree, nullptr, &method);
  napi_set_named_property(env, exports, "getUITree", method); return exports;
}
