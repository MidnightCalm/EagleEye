import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions:
                     [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // A surveyor on a roof does not want the screen sleeping between shots.
        application.isIdleTimerDisabled = true

        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = SurveyViewController()
        w.makeKeyAndVisible()
        window = w
        return true
    }
}
