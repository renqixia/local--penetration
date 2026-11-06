import Cocoa
import WebKit
import QuartzCore

// MARK: - 主入口
let app = NSApplication.shared
app.setActivationPolicy(.regular)

let delegate = AppDelegate()
app.delegate = delegate

// 确保 Dock 显示
NSApp.setActivationPolicy(.regular)

app.run()

// MARK: - App Delegate
class AppDelegate: NSObject, NSApplicationDelegate {
    var mainWindowController: MainWindowController?
    var browserWindows: [BrowserWindowController] = []
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        // 创建主窗口
        mainWindowController = MainWindowController()
        mainWindowController?.showWindow(nil)
        
        // 激活应用
        NSApp.activate(ignoringOtherApps: true)
        
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        mainWindowController?.stopNodeProcess()
    }

    func openBrowserWindow(url: URL) {
        let browser = BrowserWindowController(url: url)
        browserWindows.append(browser)
        browser.showWindow(nil)
        browser.onClose = { [weak self] in
            self?.browserWindows.removeAll { $0 === browser }
        }
    }
}

// MARK: - 主窗口控制器
class MainWindowController: NSWindowController, WKScriptMessageHandler, WKNavigationDelegate {
    var webView: WKWebView!
    var loadingView: LoadingView!
    var dynamicIslandView: DynamicIslandView!
    var containerView: NSView!
    var nodeManager: NodeProcessManager!
    private var initialNavigation: WKNavigation?
    var currentTunnelUrl: String?
    
    override init(window: NSWindow?) {
        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 750),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        
        w.title = "虚渡 VoidBridge"
        w.minSize = NSSize(width: 800, height: 600)
        w.center()
        w.titlebarAppearsTransparent = true
        w.isMovableByWindowBackground = false
        w.backgroundColor = NSColor(red: 0.945, green: 0.953, blue: 0.957, alpha: 1.0)
        
        w.titleVisibility = .hidden
        w.standardWindowButton(.zoomButton)?.isHidden = false
        w.standardWindowButton(.miniaturizeButton)?.isHidden = false
        w.standardWindowButton(.closeButton)?.isHidden = false
        
        super.init(window: w)
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }
    
    override func showWindow(_ sender: Any?) {
        super.showWindow(sender)
        setupUI()
        startNodeServer()
    }
    
    func setupUI() {
        guard let window = window else { return }
        
        // 容器视图
        containerView = NSView(frame: window.contentView!.bounds)
        containerView.autoresizingMask = [.width, .height]
        containerView.wantsLayer = true
        containerView.layer?.backgroundColor = NSColor(red: 0.945, green: 0.953, blue: 0.957, alpha: 1.0).cgColor
        window.contentView?.addSubview(containerView)
        
        // 加载视图
        loadingView = LoadingView(frame: containerView.bounds)
        loadingView.autoresizingMask = [.width, .height]
        containerView.addSubview(loadingView)
        
        // WebView 配置
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        
        // 添加消息处理器用于 JS 桥接
        config.userContentController.add(self, name: "voidbridge")
        
        // 注入 JS 桥接代码
        let bridgeScript = """
        window.VoidBridgeApp = {
            openUrl: function(url) {
                window.webkit.messageHandlers.voidbridge.postMessage({action: 'openUrl', url: url});
            },
            updateDynamicIsland: function(data) {
                window.webkit.messageHandlers.voidbridge.postMessage({action: 'updateDynamicIsland', data: data});
            },
            hideDynamicIsland: function() {
                window.webkit.messageHandlers.voidbridge.postMessage({action: 'hideDynamicIsland'});
            }
        };
        """
        let userScript = WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(userScript)
        
        // 使用临时数据存储
        config.websiteDataStore = WKWebsiteDataStore.default()
        
        webView = WKWebView(frame: containerView.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.alphaValue = 0
        webView.setValue(false, forKey: "drawsBackground")
        containerView.addSubview(webView)
        
        // 灵动岛视图
        dynamicIslandView = DynamicIslandView(frame: NSRect(x: -400, y: 20, width: 380, height: 56))
        dynamicIslandView.wantsLayer = true
        dynamicIslandView.onBackTapped = { [weak self] in
            self?.returnToToolPage()
        }
        containerView.addSubview(dynamicIslandView)
    }
    
    func startNodeServer() {
        nodeManager?.stop()
        loadingView.isHidden = false
        loadingView.alphaValue = 1
        webView.alphaValue = 0
        loadingView.startProgress()
        
        // 找到 bundle 内的资源路径
        guard let resourcesPath = Bundle.main.resourcePath else {
            loadingView.showError("无法找到应用资源")
            return
        }
        
        let nodePath = (resourcesPath as NSString).appendingPathComponent("runtime/bin/node-arm64")
        guard FileManager.default.isExecutableFile(atPath: nodePath) else {
            loadingView.showError("找不到内置的 Apple Silicon 运行环境，请重新下载完整发布包。")
            return
        }

        let serverPath = (resourcesPath as NSString).appendingPathComponent("server.mjs")
        guard FileManager.default.fileExists(atPath: serverPath) else {
            loadingView.showError("未找到服务文件 server.mjs")
            return
        }
        
        nodeManager = NodeProcessManager(nodePath: nodePath, serverPath: serverPath, resourcesPath: resourcesPath)
        
        nodeManager.onProgress = { [weak self] progress, message in
            DispatchQueue.main.async {
                self?.loadingView.updateProgress(progress, message: message)
            }
        }
        
        nodeManager.onReady = { [weak self] port in
            DispatchQueue.main.async {
                self?.serverReady(port: port)
            }
        }
        
        nodeManager.onError = { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.initialNavigation = nil
                self.webView.stopLoading()
                self.webView.alphaValue = 0
                self.loadingView.isHidden = false
                self.loadingView.alphaValue = 1
                self.loadingView.showError(error)
            }
        }
        
        nodeManager.start()
    }
    
    func serverReady(port: Int) {
        print("[虚渡] 服务已就绪，端口: \(port)")
        
        guard let request = nodeManager?.consoleRequest else { return }
        initialNavigation = webView.load(request)
    }

    private func consoleLoadFailed(_ navigation: WKNavigation?) {
        guard let navigation, navigation === initialNavigation else { return }
        initialNavigation = nil
        nodeManager?.stop()
        loadingView.showError("本机管理页加载失败，请重试。")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        consoleLoadFailed(navigation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        consoleLoadFailed(navigation)
    }
    
    func stopNodeProcess() {
        nodeManager?.stop()
    }
    
    // MARK: - WKScriptMessageHandler
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "voidbridge",
              message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == 9800,
              let body = message.body as? [String: Any],
              let action = body["action"] as? String
        else { return }
        
        DispatchQueue.main.async {
            switch action {
            case "openUrl":
                if let urlString = body["url"] as? String,
                   let url = URL(string: urlString),
                   url.scheme == "https" || url.scheme == "http" {
                    self.openInAppBrowser(url: url)
                }
                
            case "updateDynamicIsland":
                if let data = body["data"] as? [String: Any] {
                    let url = data["url"] as? String
                    let status = data["status"] as? String ?? "idle"
                    self.showDynamicIsland(url: url, status: status)
                }
                
            case "hideDynamicIsland":
                self.hideDynamicIsland()
                
            default:
                break
            }
        }
    }
    
    // MARK: - WKNavigationDelegate
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if url.scheme == "http", url.host == "127.0.0.1", url.port == 9800 {
            decisionHandler(.allow)
        } else {
            if navigationAction.navigationType == .linkActivated,
               url.scheme == "https" || url.scheme == "http" {
                openInAppBrowser(url: url)
            }
            decisionHandler(.cancel)
        }
    }
    
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if let navigation, navigation === initialNavigation {
            initialNavigation = nil
            loadingView.isHidden = true
            webView.alphaValue = 1
        }
        // 注入 JS 来重写打开链接的行为
        let script = """
        (function() {
            // 拦截所有 window.open 调用
            var originalOpen = window.open;
            window.open = function(url, target, features) {
                if (url && typeof url === 'string') {
                    window.VoidBridgeApp.openUrl(url);
                    return null;
                }
                return originalOpen.apply(this, arguments);
            };
            
            // 拦截所有 a 标签的 target="_blank"
            document.addEventListener('click', function(e) {
                var target = e.target;
                while (target && target !== document) {
                    if (target.tagName === 'A' && target.getAttribute('target') === '_blank') {
                        var href = target.getAttribute('href');
                        if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
                            e.preventDefault();
                            window.VoidBridgeApp.openUrl(href);
                            return;
                        }
                    }
                    target = target.parentElement;
                }
            }, true);
            
            // 监听 tunnel URL 变化来更新灵动岛
            var observer = new MutationObserver(function() {
                var linkEl = document.querySelector('.addr .link');
                var dotEl = document.querySelector('.dot');
                if (linkEl && linkEl.textContent && linkEl.textContent.includes('trycloudflare.com')) {
                    var status = 'idle';
                    if (dotEl) {
                        if (dotEl.classList.contains('on')) status = 'online';
                        else if (dotEl.classList.contains('loading')) status = 'loading';
                        else if (dotEl.classList.contains('error')) status = 'error';
                    }
                    window.VoidBridgeApp.updateDynamicIsland({
                        url: linkEl.textContent.trim(),
                        status: status
                    });
                } else if (!linkEl || !linkEl.textContent || !linkEl.textContent.includes('trycloudflare.com')) {
                    // 检查是否已断开
                    var mainText = document.getElementById('mainText');
                    if (mainText && mainText.textContent && mainText.textContent.includes('断开')) {
                        window.VoidBridgeApp.updateDynamicIsland({
                            url: null,
                            status: 'disconnected'
                        });
                    }
                }
            });
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        })();
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }
    
    // MARK: - 内置浏览器
    func openInAppBrowser(url: URL) {
        guard let appDelegate = NSApp.delegate as? AppDelegate else { return }
        appDelegate.openBrowserWindow(url: url)
    }
    
    // MARK: - 灵动岛
    func showDynamicIsland(url: String?, status: String) {
        currentTunnelUrl = url
        
        if url != nil && status == "online" {
            dynamicIslandView.updateURL(url: url!, status: .online)
        } else if url != nil && status == "loading" {
            dynamicIslandView.updateURL(url: url!, status: .loading)
        } else if status == "disconnected" {
            dynamicIslandView.updateURL(url: nil, status: .disconnected)
        } else {
            dynamicIslandView.updateURL(url: url, status: .connecting)
        }
        
        // 滑入动画
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.45
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            dynamicIslandView.animator().frame.origin.x = 16
        })
    }
    
    func hideDynamicIsland() {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.35
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            dynamicIslandView.animator().frame.origin.x = -400
        })
    }
    
    func returnToToolPage() {
        if let request = nodeManager?.consoleRequest {
            webView.load(request)
        }
        hideDynamicIsland()
    }
}

// MARK: - 加载视图
class LoadingView: NSView {
    private var iconView: NSImageView!
    private var titleLabel: NSTextField!
    private var subtitleLabel: NSTextField!
    private var progressBar: NSProgressIndicator!
    private var statusLabel: NSTextField!
    private var errorContainerView: NSView!
    private var errorLabel: NSTextField!
    private var errorTitle: NSTextField!
    private var retryButton: NSButton!
    private var containerLayer: CALayer!
    
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(red: 0.945, green: 0.953, blue: 0.957, alpha: 1.0).cgColor
        setupViews()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }
    
    func setupViews() {
        // 图标
        iconView = NSImageView(frame: NSRect(x: 0, y: 0, width: 120, height: 120))
        iconView.imageScaling = .scaleProportionallyUpOrDown
        iconView.wantsLayer = true
        iconView.layer?.cornerRadius = 28
        iconView.layer?.masksToBounds = true
        iconView.layer?.borderWidth = 3
        iconView.layer?.borderColor = NSColor(red: 0.125, green: 0.129, blue: 0.141, alpha: 0.3).cgColor
        
        // 加载 App Icon
        if let iconPath = Bundle.main.path(forResource: "AppIcon", ofType: "icns") {
            iconView.image = NSImage(contentsOfFile: iconPath)
        }
        
        // 标题
        titleLabel = NSTextField(labelWithString: "虚渡 VoidBridge")
        titleLabel.font = NSFont.systemFont(ofSize: 32, weight: .bold)
        titleLabel.textColor = NSColor(red: 0.125, green: 0.129, blue: 0.141, alpha: 1.0)
        titleLabel.alignment = .center
        
        // 副标题
        subtitleLabel = NSTextField(labelWithString: "正在准备你的专属工作空间...")
        subtitleLabel.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        subtitleLabel.textColor = NSColor(red: 0.373, green: 0.400, blue: 0.427, alpha: 1.0)
        subtitleLabel.alignment = .center
        
        // 进度条
        progressBar = NSProgressIndicator(frame: NSRect(x: 0, y: 0, width: 280, height: 6))
        progressBar.style = .bar
        progressBar.isIndeterminate = false
        progressBar.minValue = 0
        progressBar.maxValue = 100
        progressBar.doubleValue = 0
        progressBar.wantsLayer = true
        progressBar.layer?.cornerRadius = 3
        // progressBar styling handled via appearance
        
        // 状态文字
        statusLabel = NSTextField(labelWithString: "")
        statusLabel.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        statusLabel.textColor = NSColor(red: 0.502, green: 0.529, blue: 0.557, alpha: 1.0)
        statusLabel.alignment = .center
        
        // 错误标签（容器包裹）
        errorContainerView = NSView(frame: .zero)
        errorContainerView.wantsLayer = true
        errorContainerView.layer?.cornerRadius = 22
        errorContainerView.layer?.borderWidth = 1
        errorContainerView.layer?.borderColor = NSColor(red: 0.906, green: 0.918, blue: 0.929, alpha: 1).cgColor
        errorContainerView.layer?.shadowColor = NSColor.black.cgColor
        errorContainerView.layer?.shadowOpacity = 0.09
        errorContainerView.layer?.shadowRadius = 22
        errorContainerView.layer?.shadowOffset = CGSize(width: 0, height: -8)
        errorContainerView.layer?.backgroundColor = NSColor.white.cgColor
        errorContainerView.isHidden = true
        
        errorTitle = NSTextField(labelWithString: "需要处理一下")
        errorTitle.font = .systemFont(ofSize: 21, weight: .semibold)
        errorTitle.alignment = .center
        errorTitle.textColor = NSColor(red: 0.125, green: 0.129, blue: 0.141, alpha: 1)
        errorContainerView.addSubview(errorTitle)

        errorLabel = NSTextField(wrappingLabelWithString: "")
        errorLabel.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        errorLabel.textColor = NSColor(red: 0.235, green: 0.251, blue: 0.263, alpha: 1.0) // #3C4043
        errorLabel.alignment = .center
        errorLabel.maximumNumberOfLines = 4
        errorLabel.lineBreakMode = .byWordWrapping
        errorLabel.isHidden = false
        errorContainerView.addSubview(errorLabel)
        
        // 重试按钮
        retryButton = NSButton(title: "重试", target: nil, action: nil)
        retryButton.bezelStyle = .rounded
        retryButton.isHidden = true
        retryButton.isBordered = true
        retryButton.controlSize = .regular
        retryButton.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        retryButton.bezelColor = NSColor(red: 0.102, green: 0.451, blue: 0.910, alpha: 1.0) // #1A73E8
        retryButton.contentTintColor = .white
        
        addSubview(iconView)
        addSubview(titleLabel)
        addSubview(subtitleLabel)
        addSubview(progressBar)
        addSubview(statusLabel)
        addSubview(errorContainerView)
        errorContainerView.addSubview(retryButton)
        
        // 初始动画状态
        iconView.alphaValue = 0
        titleLabel.alphaValue = 0
        subtitleLabel.alphaValue = 0
        progressBar.alphaValue = 0
    }
    
    override func layout() {
        super.layout()
        
        let centerX = bounds.midX
        let centerY = bounds.midY
        
        iconView.frame = NSRect(x: centerX - 60, y: centerY + 20, width: 120, height: 120)
        titleLabel.frame = NSRect(x: centerX - 180, y: centerY - 55, width: 360, height: 40)
        subtitleLabel.frame = NSRect(x: centerX - 200, y: centerY - 85, width: 400, height: 20)
        progressBar.frame = NSRect(x: centerX - 140, y: centerY - 115, width: 280, height: 6)
        statusLabel.frame = NSRect(x: centerX - 200, y: centerY - 140, width: 400, height: 18)
        let cardWidth = min(460, max(240, bounds.width - 48))
        errorContainerView.frame = NSRect(x: centerX - cardWidth / 2, y: centerY - 100, width: cardWidth, height: 200)
        errorTitle.frame = NSRect(x: 24, y: 145, width: cardWidth - 48, height: 30)
        errorLabel.frame = NSRect(x: 32, y: 57, width: cardWidth - 64, height: 72)
        retryButton.frame = NSRect(x: (cardWidth - 108) / 2, y: 24, width: 108, height: 32)
    }
    
    func startProgress() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            
            self.iconView.isHidden = false
            self.titleLabel.isHidden = false
            self.progressBar.isHidden = false
            self.statusLabel.isHidden = false
            self.subtitleLabel.isHidden = false
            self.progressBar.doubleValue = 0
            // 入场动画
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.6
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                self.iconView.animator().alphaValue = 1.0
            })
            
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                NSAnimationContext.runAnimationGroup({ context in
                    context.duration = 0.5
                    context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    self.titleLabel.animator().alphaValue = 1.0
                })
            }
            
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                NSAnimationContext.runAnimationGroup({ context in
                    context.duration = 0.5
                    context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    self.subtitleLabel.animator().alphaValue = 1.0
                    self.progressBar.animator().alphaValue = 1.0
                })
            }
            
            self.errorContainerView.isHidden = true
            self.retryButton.isHidden = true
        }
    }
    
    func updateProgress(_ progress: Double, message: String) {
        DispatchQueue.main.async { [weak self] in
            self?.progressBar.doubleValue = progress
            self?.statusLabel.stringValue = message
        }
    }
    
    func showError(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.iconView.isHidden = true
            self.titleLabel.isHidden = true
            self.progressBar.isHidden = true
            self.statusLabel.isHidden = true
            self.subtitleLabel.isHidden = true
            let webIsActive = message.contains("网页模式正在运行")
            self.errorTitle.stringValue = webIsActive ? "请先关闭网页模式" : "暂时无法打开虚渡"
            self.errorLabel.stringValue = webIsActive
                ? "关闭所有虚渡网页标签页，等约 4 秒，再点「重试」。也可以在启动终端按 Control + C 立即结束网页模式。"
                : message
            self.errorContainerView.isHidden = false
            self.retryButton.isHidden = false
            self.retryButton.target = self
            self.retryButton.action = #selector(LoadingView.retryTapped)
        }
    }
    
    @objc func retryTapped() {
        // 通知外部重试
        if let windowController = NSApp.mainWindow?.windowController as? MainWindowController {
            windowController.startNodeServer()
        }
    }
}

// MARK: - 灵动岛视图
class DynamicIslandView: NSView {
    enum Status {
        case online, loading, connecting, disconnected
        
        var color: NSColor {
            switch self {
            case .online: return NSColor(red: 0.118, green: 0.557, blue: 0.243, alpha: 1.0) // 绿 #1E8E3E
            case .loading: return NSColor(red: 0.125, green: 0.129, blue: 0.141, alpha: 1.0) // 连接中
            case .connecting: return NSColor(red: 0.890, green: 0.455, blue: 0.000, alpha: 1.0) // 橙 #E37400
            case .disconnected: return NSColor(red: 0.851, green: 0.188, blue: 0.145, alpha: 1.0) // 红 #D93025
            }
        }
        
        var text: String {
            switch self {
            case .online: return "在线"
            case .loading: return "检测中"
            case .connecting: return "连接中"
            case .disconnected: return "已断开"
            }
        }
    }
    
    private var urlLabel: NSTextField!
    private var statusDot: NSView!
    private var statusLabel: NSTextField!
    private var backButton: PillButton!
    private var currentStatus: Status = .connecting
    var onBackTapped: (() -> Void)?
    
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        setupViews()
        setupAppearance()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }
    
    func setupAppearance() {
        // 乳白液态玻璃：半透白底 + 1pt 描边 + 柔和阴影
        layer?.backgroundColor = NSColor(white: 0.98, alpha: 0.85).cgColor
        layer?.cornerRadius = 28
        layer?.masksToBounds = false
        layer?.borderWidth = 1
        layer?.borderColor = NSColor(white: 0.95, alpha: 0.9).cgColor
        
        // 柔和悬浮阴影
        layer?.shadowColor = NSColor.black.withAlphaComponent(0.08).cgColor
        layer?.shadowOffset = NSSize(width: 0, height: -4)
        layer?.shadowRadius = 16
        layer?.shadowOpacity = 1.0
    }
    
    func setupViews() {
        // 手绘地球小图标（圆 + 赤道 + 经线，纯 CAShapeLayer）
        let iconView = NSView(frame: NSRect(x: 18, y: 30, width: 14, height: 14))
        iconView.wantsLayer = true
        let strokeColor = NSColor(red: 0.373, green: 0.400, blue: 0.424, alpha: 1.0).cgColor // #5F6368
        
        let circle = CAShapeLayer()
        circle.path = NSBezierPath(ovalIn: NSRect(x: 0.8, y: 0.8, width: 12.4, height: 12.4)).cgPath
        circle.strokeColor = strokeColor
        circle.fillColor = NSColor.clear.cgColor
        circle.lineWidth = 1.3
        iconView.layer?.addSublayer(circle)
        
        let equator = CAShapeLayer()
        let equatorPath = NSBezierPath()
        equatorPath.move(to: NSPoint(x: 0.3, y: 7))
        equatorPath.line(to: NSPoint(x: 13.7, y: 7))
        equator.path = equatorPath.cgPath
        equator.strokeColor = strokeColor
        equator.fillColor = NSColor.clear.cgColor
        equator.lineWidth = 1.1
        iconView.layer?.addSublayer(equator)
        
        let meridian = CAShapeLayer()
        meridian.path = NSBezierPath(ovalIn: NSRect(x: 4.1, y: 0.8, width: 5.8, height: 12.4)).cgPath
        meridian.strokeColor = strokeColor
        meridian.fillColor = NSColor.clear.cgColor
        meridian.lineWidth = 1.1
        iconView.layer?.addSublayer(meridian)
        addSubview(iconView)
        
        // URL 主文字（第一行）
        urlLabel = NSTextField(labelWithString: "")
        urlLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        urlLabel.textColor = NSColor(red: 0.125, green: 0.129, blue: 0.141, alpha: 1.0) // #202124
        urlLabel.frame = NSRect(x: 38, y: 29, width: 252, height: 17)
        urlLabel.lineBreakMode = .byTruncatingMiddle
        urlLabel.maximumNumberOfLines = 1
        addSubview(urlLabel)
        
        // 状态指示点（第二行）
        statusDot = NSView(frame: NSRect(x: 19, y: 13, width: 8, height: 8))
        statusDot.wantsLayer = true
        statusDot.layer?.cornerRadius = 4
        statusDot.layer?.backgroundColor = currentStatus.color.cgColor
        addSubview(statusDot)
        
        // 状态文字（第二行）
        statusLabel = NSTextField(labelWithString: currentStatus.text)
        statusLabel.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
        statusLabel.textColor = currentStatus.color
        statusLabel.frame = NSRect(x: 32, y: 11.5, width: 60, height: 14)
        addSubview(statusLabel)
        
        // 返回按钮：蓝色胶囊
        backButton = PillButton(frame: NSRect(x: 296, y: 12, width: 66, height: 32))
        backButton.title = "返回"
        backButton.target = self
        backButton.action = #selector(backTapped)
        addSubview(backButton)
    }
    
    func updateURL(url: String?, status: Status) {
        currentStatus = status
        
        if let url = url {
            urlLabel.stringValue = url
            urlLabel.textColor = NSColor(red: 0.125, green: 0.129, blue: 0.141, alpha: 1.0)
        } else {
            urlLabel.stringValue = "暂无公网地址"
            urlLabel.textColor = NSColor(red: 0.502, green: 0.525, blue: 0.545, alpha: 1.0) // #80868B
        }
        
        statusDot.layer?.backgroundColor = status.color.cgColor
        statusLabel.stringValue = status.text
        statusLabel.textColor = status.color
        
        // 在线状态时的脉冲动画
        if status == .online {
            addPulseAnimation()
        } else {
            removePulseAnimation()
        }
    }
    
    private func addPulseAnimation() {
        removePulseAnimation()
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1.0
        pulse.toValue = 0.4
        pulse.duration = 1.0
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        statusDot.layer?.add(pulse, forKey: "pulse")
    }
    
    private func removePulseAnimation() {
        statusDot.layer?.removeAnimation(forKey: "pulse")
    }
    
    @objc func backTapped() {
        onBackTapped?()
    }
}

// MARK: - 胶囊按钮（蓝色主按钮，带悬停反馈）
class PillButton: NSButton {
    private var isHovering = false
    
    override init(frame: NSRect) {
        super.init(frame: frame)
        isBordered = false
        bezelStyle = .inline
        wantsLayer = true
        layer?.cornerRadius = frame.height / 2
        layer?.masksToBounds = true
        applyBackground()
        styleTitle()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }
    
    private func applyBackground() {
        // Google 蓝，悬停加深
        layer?.backgroundColor = (isHovering
            ? NSColor(red: 0.094, green: 0.357, blue: 0.737, alpha: 1.0)  // #185ABC
            : NSColor(red: 0.102, green: 0.451, blue: 0.910, alpha: 1.0)  // #1A73E8
        ).cgColor
    }
    
    private func styleTitle() {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        attributedTitle = NSAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.white,
            .paragraphStyle: style
        ])
    }
    
    override var title: String {
        didSet { styleTitle() }
    }
    
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways],
            owner: self,
            userInfo: nil
        ))
    }
    
    override func mouseEntered(with event: NSEvent) {
        isHovering = true
        applyBackground()
    }
    
    override func mouseExited(with event: NSEvent) {
        isHovering = false
        applyBackground()
    }
    
    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

// MARK: - 浏览器加载遮罩：Google 四色弹跳点 + 真实进度条
// 自管理布局（重写 layout），无论窗口尺寸如何变化都保持居中
class LoadingOverlayView: NSView {
    private var dotLayers: [CALayer] = []
    private let statusLabel = NSTextField(labelWithString: "正在加载页面")
    private let progressTrack = NSView()
    private let progressFill = CALayer()
    private let retryButton = PillButton(frame: NSRect(x: 0, y: 0, width: 96, height: 34))
    private var dotsTimer: Timer?
    private var dotCount = 0
    private var lastProgress: CGFloat = 0.04
    var onRetry: (() -> Void)?
    
    private let gBlue = NSColor(red: 0.259, green: 0.522, blue: 0.957, alpha: 1.0)   // #4285F4
    private let gRed = NSColor(red: 0.918, green: 0.263, blue: 0.208, alpha: 1.0)    // #EA4335
    private let gYellow = NSColor(red: 0.984, green: 0.737, blue: 0.016, alpha: 1.0) // #FBBC04
    private let gGreen = NSColor(red: 0.204, green: 0.659, blue: 0.325, alpha: 1.0)  // #34A853
    
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(red: 0.945, green: 0.953, blue: 0.957, alpha: 1.0).cgColor
        
        // 四色弹跳点（纯 CALayer 圆点，依次波浪弹跳）
        let colors = [gBlue, gRed, gYellow, gGreen]
        for (i, color) in colors.enumerated() {
            let dot = CALayer()
            dot.cornerRadius = 6.5
            dot.backgroundColor = color.cgColor
            layer?.addSublayer(dot)
            dotLayers.append(dot)
            addBounce(to: dot, index: i)
        }
        
        // 状态文字
        statusLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        statusLabel.textColor = NSColor(red: 0.373, green: 0.400, blue: 0.427, alpha: 1.0)
        statusLabel.alignment = .center
        addSubview(statusLabel)
        
        // 进度条：浅灰轨道 + 蓝色填充
        progressTrack.wantsLayer = true
        progressTrack.layer?.cornerRadius = 2.5
        progressTrack.layer?.backgroundColor = NSColor(red: 0.906, green: 0.918, blue: 0.929, alpha: 1.0).cgColor
        addSubview(progressTrack)
        
        progressFill.cornerRadius = 2.5
        progressFill.backgroundColor = gBlue.cgColor
        progressTrack.layer?.addSublayer(progressFill)
        
        // 重试按钮
        retryButton.title = "重新加载"
        retryButton.target = self
        retryButton.action = #selector(retryTapped)
        retryButton.isHidden = true
        addSubview(retryButton)
        
        startDots()
        needsLayout = true
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }
    
    private func addBounce(to dot: CALayer, index: Int) {
        let bounce = CAKeyframeAnimation(keyPath: "transform.translation.y")
        // macOS 非 flipped 坐标系 y 轴朝上，正值才是向上弹起
        bounce.values = [0.0, 13.0, 0.0, 0.0]
        bounce.keyTimes = [0.0, 0.32, 0.64, 1.0]
        bounce.duration = 1.15
        bounce.repeatCount = .infinity
        bounce.beginTime = CACurrentMediaTime() + Double(index) * 0.14
        bounce.timingFunctions = [
            CAMediaTimingFunction(name: .easeIn),   // 弹起
            CAMediaTimingFunction(name: .easeOut),  // 落下
            CAMediaTimingFunction(name: .linear)    // 静止
        ]
        dot.add(bounce, forKey: "bounce")
    }
    
    // 布局：所有元素围绕视图中心排列，窗口缩放时自动重排
    override func layout() {
        super.layout()
        let cx = bounds.midX
        let cy = bounds.midY
        
        // 四个点：间距 30，总宽 109，水平居中
        let spacing: CGFloat = 30
        let size: CGFloat = 13
        let total = CGFloat(3) * spacing + size
        var x = cx - total / 2
        for dot in dotLayers {
            dot.frame = NSRect(x: x, y: cy + 50, width: size, height: size)
            x += spacing
        }
        
        statusLabel.frame = NSRect(x: cx - 200, y: cy + 18, width: 400, height: 18)
        progressTrack.frame = NSRect(x: cx - 110, y: cy - 14, width: 220, height: 5)
        progressFill.frame = NSRect(x: 0, y: 0, width: max(8, 220 * lastProgress), height: 5)
        retryButton.frame = NSRect(x: cx - 48, y: cy - 72, width: 96, height: 34)
    }
    
    // MARK: - 状态切换
    func setProgress(_ p: CGFloat) {
        let clamped = max(0.04, min(0.96, p))
        lastProgress = clamped
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.25)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .easeOut))
        progressFill.frame = NSRect(x: 0, y: 0, width: max(8, 220 * clamped), height: 5)
        CATransaction.commit()
    }
    
    func showError(_ message: String) {
        stopDots()
        // 点变灰并停止弹跳
        for dot in dotLayers {
            dot.removeAnimation(forKey: "bounce")
            dot.backgroundColor = NSColor(white: 0.78, alpha: 1.0).cgColor
        }
        statusLabel.stringValue = "加载失败：" + message
        statusLabel.textColor = NSColor(red: 0.851, green: 0.188, blue: 0.145, alpha: 1.0)
        progressFill.backgroundColor = NSColor(red: 0.851, green: 0.188, blue: 0.145, alpha: 1.0).cgColor
        retryButton.isHidden = false
        needsLayout = true
    }
    
    func resetToLoading() {
        // 恢复四色 + 弹跳 + 蓝色进度条
        let colors = [gBlue, gRed, gYellow, gGreen]
        for (i, dot) in dotLayers.enumerated() {
            dot.backgroundColor = colors[i].cgColor
            addBounce(to: dot, index: i)
        }
        statusLabel.stringValue = "正在加载页面"
        statusLabel.textColor = NSColor(red: 0.373, green: 0.400, blue: 0.427, alpha: 1.0)
        progressFill.backgroundColor = gBlue.cgColor
        lastProgress = 0.04
        progressFill.frame = NSRect(x: 0, y: 0, width: 8, height: 5)
        retryButton.isHidden = true
        isHidden = false
        alphaValue = 1
        startDots()
        needsLayout = true
    }
    
    // 文字后面的省略号循环
    private func startDots() {
        stopDots()
        dotsTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: true) { [weak self] _ in
            guard let self = self, !self.isHidden else { return }
            self.dotCount = (self.dotCount + 1) % 4
            var dots = ""
            for _ in 0..<self.dotCount { dots += " ·" }
            self.statusLabel.stringValue = "正在加载页面" + dots
        }
    }
    
    private func stopDots() {
        dotsTimer?.invalidate()
        dotsTimer = nil
    }
    
    func teardown() {
        stopDots()
        for dot in dotLayers { dot.removeAnimation(forKey: "bounce") }
    }
    
    @objc private func retryTapped() {
        onRetry?()
    }
}

// MARK: - 内置浏览器窗口控制器
class BrowserWindowController: NSWindowController, WKNavigationDelegate {
    private var webView: WKWebView!
    private var loadingOverlay: LoadingOverlayView!
    private var progressObservation: NSKeyValueObservation?
    var onClose: (() -> Void)?
    private let targetURL: URL
    
    init(url: URL) {
        self.targetURL = url
        
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1024, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        
        window.title = "虚渡 - 浏览"
        window.minSize = NSSize(width: 400, height: 300)
        window.center()
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(red: 0.945, green: 0.953, blue: 0.957, alpha: 1.0)
        
        super.init(window: window)
        setupBrowser()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }
    
    func setupBrowser() {
        guard let window = window, let contentView = window.contentView else { return }
        
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        
        // WebView
        webView = WKWebView(frame: contentView.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.alphaValue = 0
        contentView.addSubview(webView)
        
        // 加载遮罩：Google 四色弹跳点 + 真实进度条（自带居中布局）
        loadingOverlay = LoadingOverlayView(frame: contentView.bounds)
        loadingOverlay.autoresizingMask = [.width, .height]
        loadingOverlay.onRetry = { [weak self] in
            self?.reloadTarget()
        }
        contentView.addSubview(loadingOverlay)
        
        // 加载 URL（允许协议缓存，重复访问显著提速）
        let request = URLRequest(url: targetURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 20)
        webView.load(request)
        
        // 监听 WebView 真实加载进度，驱动进度条
        progressObservation = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] _, change in
            DispatchQueue.main.async {
                guard let self = self, !self.loadingOverlay.isHidden, let p = change.newValue else { return }
                self.loadingOverlay.setProgress(CGFloat(p))
            }
        }
        
        // 监听窗口关闭
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(windowWillClose),
            name: NSWindow.willCloseNotification,
            object: window
        )
    }
    
    private func reloadTarget() {
        loadingOverlay.resetToLoading()
        let request = URLRequest(url: targetURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 20)
        webView.load(request)
    }
    
    @objc func windowWillClose() {
        progressObservation?.invalidate()
        loadingOverlay.teardown()
        webView.configuration.websiteDataStore.removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: Date(timeIntervalSince1970: 0),
            completionHandler: {}
        )
        onClose?()
        NotificationCenter.default.removeObserver(self)
    }
    
    // MARK: - WKNavigationDelegate
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        window?.title = webView.title ?? "虚渡 - 浏览"
    }
    
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        window?.title = webView.title ?? "虚渡 - 浏览"
        
        // 进度条走满
        loadingOverlay.setProgress(1.0)
        
        // 隐藏加载遮罩，淡入页面
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.35
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            loadingOverlay.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            self?.loadingOverlay.isHidden = true
            self?.loadingOverlay.teardown()
            
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.3
                self?.webView.animator().alphaValue = 1.0
            })
        })
    }
    
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error.localizedDescription)
    }
    
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error.localizedDescription)
    }
    
    private func showLoadError(_ message: String) {
        loadingOverlay.showError(message)
    }
}

// MARK: - Node.js 进程管理器
class NodeProcessManager {
    private let nodePath: String
    private let serverPath: String
    private let resourcesPath: String
    private let appToken = UUID().uuidString
    private var process: Process?
    private var readyTimer: Timer?
    private var outputTail = Data()

    var consoleRequest: URLRequest {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:9800/")!,
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.setValue(appToken, forHTTPHeaderField: "X-VoidBridge-App")
        return request
    }

    var onProgress: ((Double, String) -> Void)?
    var onReady: ((Int) -> Void)?
    var onError: ((String) -> Void)?

    init(nodePath: String, serverPath: String, resourcesPath: String) {
        self.nodePath = nodePath
        self.serverPath = serverPath
        self.resourcesPath = resourcesPath
    }

    func start() {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: nodePath)
        child.arguments = [serverPath, "--app"]
        child.currentDirectoryURL = URL(fileURLWithPath: resourcesPath)
        var environment = ProcessInfo.processInfo.environment
        environment["VOIDBRIDGE_APP_TOKEN"] = appToken
        environment["VOIDBRIDGE_APP_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        child.environment = environment

        let output = Pipe()
        child.standardOutput = output
        child.standardError = output
        output.fileHandleForReading.readabilityHandler = { [weak self, weak child] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            DispatchQueue.main.async {
                guard let self, let child, self.process === child, self.readyTimer != nil else { return }
                self.outputTail.append(data)
                if String(decoding: self.outputTail, as: UTF8.self).contains("虚渡 VoidBridge已就绪：") {
                    self.readyTimer?.invalidate()
                    self.readyTimer = nil
                    self.outputTail.removeAll()
                    self.onProgress?(100, "本机服务已就绪")
                    self.onReady?(9800)
                } else if self.outputTail.count > 4096 {
                    self.outputTail = Data(self.outputTail.suffix(512))
                }
            }
        }
        child.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, self.process === finished else { return }
                self.readyTimer?.invalidate()
                self.readyTimer = nil
                self.process = nil
                switch finished.terminationStatus {
                case 73: self.onError?("虚渡 App 已在运行，请返回原窗口。")
                case 74: self.onError?("虚渡网页模式正在运行。请在启动终端按 Control+C 后重试。")
                case 75: self.onError?("端口 9800 已被其他程序占用。请检查占用程序后重试。")
                default: self.onError?("虚渡的本机服务已退出，请重试。")
                }
            }
        }

        do {
            try child.run()
            process = child
            onProgress?(30, "正在启动本机服务…")
            readyTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { [weak self] _ in
                guard let self else { return }
                self.stop()
                self.onError?("本机服务启动超时，请重试。")
            }
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            onError?("启动服务失败：\(error.localizedDescription)")
        }
    }

    func stop() {
        readyTimer?.invalidate()
        readyTimer = nil
        let child = process
        process = nil
        if let child, child.isRunning { child.terminate() }
    }
}
