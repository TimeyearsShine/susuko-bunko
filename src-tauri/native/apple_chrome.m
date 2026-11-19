#import <TargetConditionals.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

#if TARGET_OS_IOS
#import <UIKit/UIKit.h>
#if __IPHONE_OS_VERSION_MAX_ALLOWED >= 260000
#define SUSUKO_HAS_GLASS 1
#endif
#else
#import <AppKit/AppKit.h>
#if __MAC_OS_X_VERSION_MAX_ALLOWED >= 260000
#define SUSUKO_HAS_GLASS 1
#endif
#endif

#if SUSUKO_HAS_GLASS
#if TARGET_OS_IOS
typedef UIView PlatformView;
typedef UIButton PlatformButton;
#else
typedef NSView PlatformView;
typedef NSButton PlatformButton;
#endif

static NSString *const channel = @"susukoAppleChrome";
static char buttonID;

@interface SusukoGlassControl : NSObject
@property (nonatomic, strong) PlatformView *surface;
@property (nonatomic, strong) PlatformButton *button;
@property (nonatomic, copy) NSDictionary *appearance;
@end
@implementation SusukoGlassControl
@end

@interface SusukoAppleChrome : NSObject <WKScriptMessageHandlerWithReply>
@property (nonatomic, weak) WKWebView *webView;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, SusukoGlassControl *> *controls;
@end

@implementation SusukoAppleChrome

- (void)activate:(PlatformButton *)sender {
    NSNumber *identifier = objc_getAssociatedObject(sender, &buttonID);
    if (!identifier || self.controls[identifier].button != sender) return;
    [self.webView evaluateJavaScript:[NSString stringWithFormat:
        @"window.__susukoActivateGlass?.(%@)", identifier] completionHandler:nil];
}

- (SusukoGlassControl *)makeControl:(NSNumber *)identifier API_AVAILABLE(ios(26.0), macos(26.0)) {
    SusukoGlassControl *control = [SusukoGlassControl new];
#if TARGET_OS_IOS
    UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
    button.isAccessibilityElement = NO;
    [button addTarget:self action:@selector(activate:) forControlEvents:UIControlEventPrimaryActionTriggered];
    control.surface = button;
#else
    NSButton *button = [NSButton buttonWithTitle:@"" target:self action:@selector(activate:)];
    button.bordered = NO;
    button.focusRingType = NSFocusRingTypeNone;
    button.refusesFirstResponder = YES;
    [button setAccessibilityElement:NO];
    NSGlassEffectView *glass = [NSGlassEffectView new];
    if (@available(macOS 27.0, *)) glass.effectIsInteractive = YES;
    glass.contentView = button;
    control.surface = glass;
#endif
    control.button = button;
    objc_setAssociatedObject(button, &buttonID, identifier, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return control;
}

- (BOOL)configure:(SusukoGlassControl *)control from:(NSDictionary *)item
    API_AVAILABLE(ios(26.0), macos(26.0)) {
    NSString *symbol = item[@"symbol"];
    NSString *title = item[@"title"];
    NSString *tooltip = item[@"tooltip"];
    if (![symbol isKindOfClass:NSString.class] || symbol.length > 64 ||
        ![title isKindOfClass:NSString.class] || title.length > 24) return NO;
    if (![tooltip isKindOfClass:NSString.class] || tooltip.length > 200) tooltip = @"";

    BOOL primary = [item[@"primary"] isEqual:@YES];
    BOOL selected = [item[@"selected"] isEqual:@YES];
    BOOL dark = [item[@"dark"] isEqual:@YES];
    NSNumber *textSize = item[@"textSize"];
    CGFloat pointSize = [textSize isKindOfClass:NSNumber.class] ? textSize.doubleValue : 16;
    if (!(pointSize >= 13 && pointSize <= 20)) pointSize = 16;
    NSDictionary *appearance = @{@"symbol": symbol, @"title": title, @"primary": @(primary),
        @"selected": @(selected), @"dark": @(dark), @"textSize": @(pointSize), @"tooltip": tooltip};
    if ([appearance isEqual:control.appearance]) return YES;
#if TARGET_OS_IOS
    UIImage *image = [UIImage systemImageNamed:symbol];
    if (!image) return NO;
    UIButtonConfiguration *configuration = primary
        ? [UIButtonConfiguration prominentGlassButtonConfiguration]
        : [UIButtonConfiguration glassButtonConfiguration];
    configuration.image = image;
    configuration.preferredSymbolConfigurationForImage =
        [UIImageSymbolConfiguration configurationWithPointSize:pointSize weight:UIImageSymbolWeightSemibold];
    if (title.length) {
        configuration.attributedTitle = [[NSAttributedString alloc] initWithString:title
            attributes:@{NSFontAttributeName: [UIFont systemFontOfSize:pointSize weight:UIFontWeightSemibold]}];
    }
    configuration.imagePadding = 5;
    configuration.contentInsets = NSDirectionalEdgeInsetsMake(0, 0, 0, 0);
    configuration.cornerStyle = UIButtonConfigurationCornerStyleCapsule;
    configuration.baseForegroundColor = primary ? UIColor.whiteColor : selected ? UIColor.systemBlueColor : UIColor.labelColor;
    if (primary) configuration.baseBackgroundColor = UIColor.systemBlueColor;
    control.button.overrideUserInterfaceStyle = dark ? UIUserInterfaceStyleDark : UIUserInterfaceStyleLight;
    control.button.configuration = configuration;
#else
    NSImage *image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:nil];
    if (!image) return NO;
    NSGlassEffectView *glass = (NSGlassEffectView *)control.surface;
    glass.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
    glass.tintColor = primary ? NSColor.controlAccentColor : nil;
    control.button.contentTintColor = primary ? NSColor.whiteColor : selected ? NSColor.controlAccentColor : NSColor.labelColor;
    control.button.image = [image imageWithSymbolConfiguration:
        [NSImageSymbolConfiguration configurationWithPointSize:pointSize weight:NSFontWeightSemibold]];
    control.button.title = title;
    control.button.toolTip = tooltip.length ? tooltip : nil;
    control.button.imagePosition = title.length ? NSImageLeft : NSImageOnly;
    control.button.font = [NSFont systemFontOfSize:pointSize weight:NSFontWeightSemibold];
#endif
    control.appearance = appearance;
    return YES;
}

- (void)removeControlsExcept:(NSArray<NSNumber *> *)identifiers {
    NSSet *keep = [NSSet setWithArray:identifiers];
    for (NSNumber *key in self.controls.allKeys) {
        if ([keep containsObject:key]) continue;
        [self.controls[key].surface removeFromSuperview];
        [self.controls removeObjectForKey:key];
    }
}

- (NSArray<NSNumber *> *)updateControls:(NSArray *)items API_AVAILABLE(ios(26.0), macos(26.0)) {
    WKWebView *webView = self.webView;
    NSMutableArray<NSNumber *> *visible = [NSMutableArray array];
    CGRect bounds = webView.bounds;
    for (id entry in items) {
        if (![entry isKindOfClass:NSDictionary.class]) continue;
        NSDictionary *item = entry;
        NSNumber *identifier = item[@"id"];
        if (![identifier isKindOfClass:NSNumber.class] || identifier.intValue <= 0) continue;
        NSArray *geometry = item[@"rect"];
        if (![geometry isKindOfClass:NSArray.class] || geometry.count != 4) continue;
        BOOL numeric = YES;
        for (id coordinate in geometry) numeric &= [coordinate isKindOfClass:NSNumber.class];
        if (!numeric) continue;
        CGRect frame = CGRectMake([geometry[0] doubleValue], [geometry[1] doubleValue],
                                  [geometry[2] doubleValue], [geometry[3] doubleValue]);
        if (!(frame.size.width >= 30 && frame.size.width <= 155 &&
              frame.size.height >= 30 && frame.size.height <= 62 &&
              CGRectContainsRect(CGRectInset(bounds, -1, -1), frame))) continue;

        SusukoGlassControl *control = self.controls[identifier] ?: [self makeControl:identifier];
        if (![self configure:control from:item]) continue;
#if TARGET_OS_IOS
        control.surface.frame = frame;
        if (!control.surface.superview) [webView addSubview:control.surface];
#else
        if (!webView.isFlipped) frame.origin.y = CGRectGetHeight(bounds) - CGRectGetMaxY(frame);
        control.surface.frame = frame;
        NSGlassEffectView *glass = (NSGlassEffectView *)control.surface;
        glass.cornerRadius = CGRectGetHeight(frame) / 2;
        control.button.frame = glass.bounds;
        control.button.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        if (!glass.superview) [webView addSubview:glass positioned:NSWindowAbove relativeTo:nil];
#endif
        self.controls[identifier] = control;
        [visible addObject:identifier];
    }
    [self removeControlsExcept:visible];
    return visible;
}

- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message
                 replyHandler:(void (^)(id, NSString *))replyHandler {
    NSURL *url = message.frameInfo.request.URL;
    if (message.webView != self.webView || !message.frameInfo.isMainFrame ||
        ![url.scheme isEqualToString:@"tauri"] || ![url.host isEqualToString:@"localhost"]) {
        replyHandler(@[], nil);
        return;
    }
    NSArray *items = message.body;
    if (![items isKindOfClass:NSArray.class] || items.count > 24) {
        replyHandler(@[], nil);
        return;
    }
    if (@available(iOS 26.0, macOS 26.0, *)) {
        replyHandler([self updateControls:items], nil);
    } else {
        replyHandler(@[], nil);
    }
}
@end
#endif

void susuko_install_apple_chrome(void *handle) {
#if SUSUKO_HAS_GLASS
    if (@available(iOS 26.0, macOS 26.0, *)) {
        WKWebView *webView = (__bridge WKWebView *)handle;
        SusukoAppleChrome *chrome = [SusukoAppleChrome new];
        chrome.webView = webView;
        chrome.controls = [NSMutableDictionary dictionary];
        [webView.configuration.userContentController
            addScriptMessageHandlerWithReply:chrome contentWorld:WKContentWorld.pageWorld name:channel];
        [webView evaluateJavaScript:@"window.dispatchEvent(new Event('susuko-glass-ready'))" completionHandler:nil];
    }
#endif
}
