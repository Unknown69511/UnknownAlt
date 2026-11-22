use tauri::{AppHandle, Manager};
use webview2_com::{
    AcceleratorKeyPressedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_PHYSICAL_KEY_STATUS,
    },
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_ESCAPE, VK_F11, VK_MENU, VK_SHIFT};

// The native handler covers both the app webview and the isolated Roblox Browse
// child. The page never receives extra IPC permissions or injected shortcuts.
pub fn attach(app: AppHandle, view: tauri::webview::PlatformWebview) -> windows::core::Result<()> {
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut key = 0;
        let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
        let mut key_status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
        // SAFETY: callback runs on the UI thread, with live WebView2 event args.
        unsafe {
            args.VirtualKey(&mut key)?;
            args.KeyEventKind(&mut kind)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || key != u32::from(VK_F11.0) && key != u32::from(VK_ESCAPE.0) {
                return Ok(());
            }
            if [VK_CONTROL, VK_MENU, VK_SHIFT].iter().any(|modifier| GetKeyState(i32::from(modifier.0)) < 0) {
                return Ok(());
            }
            let Some(window) = app.get_window("main") else { return Ok(()) };
            let fullscreen = window.is_fullscreen().unwrap_or(false);
            let escape = key == u32::from(VK_ESCAPE.0);
            if escape && !fullscreen {
                return Ok(());
            }
            args.SetHandled(true)?;
            args.PhysicalKeyStatus(&mut key_status)?;
            if key_status.WasKeyDown.as_bool() {
                return Ok(());
            }
            // Dispatch after returning from the accelerator callback. Tao restores
            // the previous maximized or restored placement on exit.
            tauri::async_runtime::spawn(async move {
                let handle = window.app_handle().clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Err(error) = window.set_fullscreen(!fullscreen && !escape) {
                        log::warn!("Could not change the main window fullscreen state: {error}");
                    }
                });
            });
        }
        Ok(())
    }));
    // SAFETY: the caller supplies the live controller from with_webview.
    unsafe { view.controller().add_AcceleratorKeyPressed(&handler, &mut 0) }
}
