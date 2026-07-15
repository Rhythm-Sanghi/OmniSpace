#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use std::io::{Read, Write};
use tauri::Manager;

#[cfg(target_os = "linux")]
use lazy_static::lazy_static;

static IS_TRACKING: AtomicBool = AtomicBool::new(false);
static IS_CAPTURING_MACOS: AtomicBool = AtomicBool::new(false);
static IS_CAPTURING_AUDIO: AtomicBool = AtomicBool::new(false);
lazy_static! {
  static ref AUDIO_BUFFER: Mutex<Vec<u8>> = Mutex::new(Vec::new());
}

struct TrackingState {
  thread_id: u32,
  hook_handle: isize,
}

static TRACKING_STATE: Mutex<Option<TrackingState>> = Mutex::new(None);
static JOIN_HANDLE: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

static TARGET_HWND: Mutex<Option<usize>> = Mutex::new(None);
static TAURI_APP: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

static CAPTURE_PORT: Mutex<Option<u16>> = Mutex::new(None);
static CAPTURE_WINDOW_ID: Mutex<Option<u32>> = Mutex::new(None);
static CAPTURE_TOKEN: Mutex<Option<String>> = Mutex::new(None);

#[derive(serde::Serialize, Clone, Debug)]
struct WindowInfo {
  handle: usize,
  title: String,
}

#[derive(serde::Serialize, Clone, Debug)]
struct BoundsPayload {
  handle: usize,
  x: i32,
  y: i32,
  width: i32,
  height: i32,
}

// Discriminated unions matching inputProtocol.ts
#[derive(serde::Deserialize, Debug)]
struct MouseMovePayload {
  x: i32,
  y: i32,
}

#[derive(serde::Deserialize, Debug)]
struct MouseButtonPayload {
  x: i32,
  y: i32,
  button: i32,
}

#[derive(serde::Deserialize, Debug)]
struct MouseScrollPayload {
  x: i32,
  y: i32,
  #[serde(rename = "deltaX")]
  delta_x: f64,
  #[serde(rename = "deltaY")]
  delta_y: f64,
}

#[derive(serde::Deserialize, Debug)]
struct KeyboardKeyPayload {
  code: String,
  key: String,
}

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "type", content = "data", rename_all = "lowercase")]
enum InputEventPayload {
  Mousemove(MouseMovePayload),
  Mousedown(MouseButtonPayload),
  Mouseup(MouseButtonPayload),
  Scroll(MouseScrollPayload),
  Keydown(KeyboardKeyPayload),
  Keyup(KeyboardKeyPayload),
}

// Windows native imports
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{HWND, LPARAM, BOOL, RECT};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
  EnumWindows, GetWindowTextW, GetWindowTextLengthW, IsWindowVisible,
  GetWindowRect, PostThreadMessageW, GetMessageW, TranslateMessage,
  DispatchMessageW, MSG, WM_QUIT, PostQuitMessage, GetSystemMetrics,
  SM_CXSCREEN, SM_CYSCREEN
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
  SendInput, INPUT, INPUT_MOUSE, INPUT_KEYBOARD, MOUSEINPUT, KEYBDINPUT,
  MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
  MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
  MOUSEEVENTF_WHEEL, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::DataExchange::{
  OpenClipboard, CloseClipboard, EmptyClipboard, GetClipboardData, SetClipboardData
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock, GlobalAlloc, GlobalFree};

#[cfg(target_os = "windows")]
const EVENT_OBJECT_DESTROY: u32 = 0x8001;
#[cfg(target_os = "windows")]
const EVENT_OBJECT_LOCATIONCHANGE: u32 = 0x800B;
#[cfg(target_os = "windows")]
const OBJID_WINDOW: i32 = 0x00000000;
#[cfg(target_os = "windows")]
const CHILDID_SELF: i32 = 0;
#[cfg(target_os = "windows")]
const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
  let list = &mut *(lparam as *mut Vec<WindowInfo>);
  if IsWindowVisible(hwnd) != 0 {
    let len = GetWindowTextLengthW(hwnd);
    if len > 0 {
      let mut buf = vec![0u16; (len + 1) as usize];
      let read = GetWindowTextW(hwnd, buf.as_mut_ptr(), len + 1);
      if read > 0 {
        let title = String::from_utf16_lossy(&buf[..read as usize]);
        if !title.trim().is_empty() {
          list.push(WindowInfo {
            handle: hwnd as usize,
            title,
          });
        }
      }
    }
  }
  1
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn win_event_proc(
  _h_win_event_hook: HWINEVENTHOOK,
  event: u32,
  hwnd: HWND,
  id_object: i32,
  id_child: i32,
  _id_event_thread: u32,
  _dwms_event_time: u32,
) {
  let target = match TARGET_HWND.lock() {
    Ok(lock) => match *lock {
      Some(t) => t,
      None => return,
    },
    Err(_) => return,
  };

  if hwnd as usize != target {
    return;
  }

  if id_object != OBJID_WINDOW || id_child != CHILDID_SELF {
    return;
  }

  if event == EVENT_OBJECT_LOCATIONCHANGE {
    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    if GetWindowRect(hwnd, &mut rect) != 0 {
      let width = rect.right - rect.left;
      let height = rect.bottom - rect.top;

      if let Ok(app_lock) = TAURI_APP.lock() {
        if let Some(app_handle) = &*app_lock {
          app_handle.emit_all("native-window-bounds", BoundsPayload {
            handle: target,
            x: rect.left,
            y: rect.top,
            width,
            height,
          }).ok();
        }
      }
    }
  } else if event == EVENT_OBJECT_DESTROY {
    if let Ok(app_lock) = TAURI_APP.lock() {
      if let Some(app_handle) = &*app_lock {
        app_handle.emit_all("native-window-closed", target).ok();
      }
    }
    PostQuitMessage(0);
  }
}

// Windows native keyboard key-to-scancode translation table
#[cfg(target_os = "windows")]
fn code_to_scancode(code: &str) -> u16 {
  match code {
    "KeyA" => 0x1E,
    "KeyB" => 0x30,
    "KeyC" => 0x2E,
    "KeyD" => 0x20,
    "KeyE" => 0x12,
    "KeyF" => 0x21,
    "KeyG" => 0x22,
    "KeyH" => 0x23,
    "KeyI" => 0x17,
    "KeyJ" => 0x24,
    "KeyK" => 0x25,
    "KeyL" => 0x26,
    "KeyM" => 0x32,
    "KeyN" => 0x31,
    "KeyO" => 0x18,
    "KeyP" => 0x19,
    "KeyQ" => 0x10,
    "KeyR" => 0x13,
    "KeyS" => 0x1F,
    "KeyT" => 0x14,
    "KeyU" => 0x16,
    "KeyV" => 0x2F,
    "KeyW" => 0x11,
    "KeyX" => 0x2D,
    "KeyY" => 0x15,
    "KeyZ" => 0x2C,
    "Digit1" => 0x02,
    "Digit2" => 0x03,
    "Digit3" => 0x04,
    "Digit4" => 0x05,
    "Digit5" => 0x06,
    "Digit6" => 0x07,
    "Digit7" => 0x08,
    "Digit8" => 0x09,
    "Digit9" => 0x0A,
    "Digit0" => 0x0B,
    "Enter" => 0x1C,
    "Escape" => 0x01,
    "Backspace" => 0x0E,
    "Tab" => 0x0F,
    "Space" => 0x39,
    "Minus" => 0x0C,
    "Equal" => 0x0D,
    "BracketLeft" => 0x1A,
    "BracketRight" => 0x1B,
    "Backslash" => 0x2B,
    "Semicolon" => 0x27,
    "Quote" => 0x28,
    "Backquote" => 0x29,
    "Comma" => 0x33,
    "Period" => 0x34,
    "Slash" => 0x35,
    "ShiftLeft" => 0x2A,
    "ShiftRight" => 0x36,
    "ControlLeft" => 0x1D,
    "AltLeft" => 0x38,
    "ArrowUp" => 0xE048,
    "ArrowDown" => 0xE050,
    "ArrowLeft" => 0xE04B,
    "ArrowRight" => 0xE04D,
    _ => 0,
  }
}

#[cfg(target_os = "windows")]
fn get_scancode_info(code: &str) -> (u16, bool) {
  let scancode = code_to_scancode(code);
  let is_extended = (scancode & 0xFF00) == 0xE000;
  let code_val = if is_extended { scancode & 0x00FF } else { scancode };
  (code_val, is_extended)
}

#[cfg(target_os = "windows")]
fn inject_mouse_event(flags: u32, x: i32, y: i32, data: u32) {
  unsafe {
    let screen_width = GetSystemMetrics(SM_CXSCREEN);
    let screen_height = GetSystemMetrics(SM_CYSCREEN);
    if screen_width <= 0 || screen_height <= 0 { return; }

    let normalized_x = (x * 65535) / screen_width;
    let normalized_y = (y * 65535) / screen_height;

    let mut input = INPUT {
      r#type: INPUT_MOUSE,
      Anonymous: std::mem::zeroed(),
    };

    input.Anonymous.mi = MOUSEINPUT {
      dx: normalized_x,
      dy: normalized_y,
      mouseData: data,
      dwFlags: flags | MOUSEEVENTF_ABSOLUTE,
      time: 0,
      dwExtraInfo: 0,
    };

    SendInput(1, &mut input, std::mem::size_of::<INPUT>() as i32);
  }
}

#[cfg(target_os = "windows")]
fn inject_key_event(code: &str, is_up: bool) {
  unsafe {
    let (scancode, is_extended) = get_scancode_info(code);
    if scancode == 0 { return; }

    let mut input = INPUT {
      r#type: INPUT_KEYBOARD,
      Anonymous: std::mem::zeroed(),
    };

    let mut flags = KEYEVENTF_SCANCODE;
    if is_up {
      flags |= KEYEVENTF_KEYUP;
    }
    if is_extended {
      flags |= 0x0001; // KEYEVENTF_EXTENDEDKEY
    }

    input.Anonymous.ki = KEYBDINPUT {
      wVk: 0,
      wScan: scancode,
      dwFlags: flags,
      time: 0,
      dwExtraInfo: 0,
    };

    SendInput(1, &mut input, std::mem::size_of::<INPUT>() as i32);
  }
}

#[cfg(target_os = "windows")]
fn inject_scroll_event(x: i32, y: i32, _delta_x: f64, delta_y: f64) {
  let wheel_delta = if delta_y > 0.0 { -120 } else if delta_y < 0.0 { 120 } else { 0 };
  if wheel_delta != 0 {
    inject_mouse_event(MOUSEEVENTF_WHEEL, x, y, wheel_delta as u32);
  }
}

fn base64_encode(bytes: &[u8]) -> String {
  const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut result = String::with_capacity((bytes.len() + 2) / 3 * 4);
  let mut i = 0;
  while i < bytes.len() {
    let b0 = bytes[i] as usize;
    let b1 = if i + 1 < bytes.len() { bytes[i + 1] as usize } else { 0 };
    let b2 = if i + 2 < bytes.len() { bytes[i + 2] as usize } else { 0 };
    
    let enc0 = b0 >> 2;
    let enc1 = ((b0 & 3) << 4) | (b1 >> 4);
    let enc2 = ((b1 & 15) << 2) | (b2 >> 6);
    let enc3 = b2 & 63;
    
    result.push(CHARS[enc0] as char);
    result.push(CHARS[enc1] as char);
    if i + 1 < bytes.len() {
      result.push(CHARS[enc2] as char);
    } else {
      result.push('=');
    }
    if i + 2 < bytes.len() {
      result.push(CHARS[enc3] as char);
    } else {
      result.push('=');
    }
    i += 3;
  }
  result
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
  let s = s.trim();
  if s.len() % 4 != 0 {
    return None;
  }
  let mut result = Vec::with_capacity(s.len() / 4 * 3);
  let bytes = s.as_bytes();
  
  let decode_char = |c: u8| -> Option<u8> {
    match c {
      b'A'..=b'Z' => Some(c - b'A'),
      b'a'..=b'z' => Some(c - b'a' + 26),
      b'0'..=b'9' => Some(c - b'0' + 52),
      b'+' => Some(62),
      b'/' => Some(63),
      b'=' => Some(0),
      _ => None,
    }
  };

  let mut i = 0;
  while i < bytes.len() {
    let enc0 = decode_char(bytes[i])?;
    let enc1 = decode_char(bytes[i + 1])?;
    let enc2 = decode_char(bytes[i + 2])?;
    let enc3 = decode_char(bytes[i + 3])?;

    let b0 = (enc0 << 2) | (enc1 >> 4);
    let b1 = ((enc1 & 15) << 4) | (enc2 >> 2);
    let b2 = ((enc2 & 3) << 6) | enc3;

    result.push(b0);
    if bytes[i + 2] != b'=' {
      result.push(b1);
    }
    if bytes[i + 3] != b'=' {
      result.push(b2);
    }
    i += 4;
  }
  Some(result)
}

#[cfg(target_os = "windows")]
fn get_clipboard_text() -> Result<String, String> {
  unsafe {
    use windows_sys::Win32::System::DataExchange::{
      OpenClipboard, CloseClipboard, GetClipboardData, IsClipboardFormatAvailable
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    if OpenClipboard(0) == 0 {
      return Err("Failed to open clipboard".into());
    }

    if IsClipboardFormatAvailable(13) != 0 { // CF_UNICODETEXT = 13
      let handle = GetClipboardData(13);
      if handle.is_null() {
        CloseClipboard();
        return Err("Failed to get unicode text handle".into());
      }
      let ptr = GlobalLock(handle) as *const u16;
      if ptr.is_null() {
        CloseClipboard();
        return Err("Failed to lock unicode text handle".into());
      }
      let mut len = 0;
      while *ptr.add(len) != 0 {
        len += 1;
      }
      let slice = std::slice::from_raw_parts(ptr, len);
      let text = String::from_utf16_lossy(slice);
      GlobalUnlock(handle);
      CloseClipboard();
      return Ok(text);
    }

    if IsClipboardFormatAvailable(8) != 0 { // CF_DIB = 8
      let handle = GetClipboardData(8);
      if handle.is_null() {
        CloseClipboard();
        return Err("Failed to get DIB handle".into());
      }
      let ptr = GlobalLock(handle);
      if ptr.is_null() {
        CloseClipboard();
        return Err("Failed to lock DIB handle".into());
      }
      
      let header = &*(ptr as *const windows_sys::Win32::UI::WindowsAndMessaging::BITMAPINFOHEADER);
      let header_size = header.biSize as usize;
      let image_size = if header.biSizeImage == 0 {
        let width = header.biWidth as usize;
        let height = header.biHeight.abs() as usize;
        let bpp = header.biBitCount as usize;
        let row_stride = ((width * bpp + 31) / 32) * 4;
        row_stride * height
      } else {
        header.biSizeImage as usize;
      };
      
      let total_dib_size = header_size + image_size;
      let dib_slice = std::slice::from_raw_parts(ptr as *const u8, total_dib_size);
      
      let file_size = 14 + total_dib_size;
      let mut bmp_file = Vec::with_capacity(file_size);
      bmp_file.extend_from_slice(b"BM");
      bmp_file.extend_from_slice(&(file_size as u32).to_le_bytes());
      bmp_file.extend_from_slice(&[0, 0, 0, 0]);
      
      let offset = 14 + header_size;
      bmp_file.extend_from_slice(&(offset as u32).to_le_bytes());
      bmp_file.extend_from_slice(dib_slice);
      
      GlobalUnlock(handle);
      CloseClipboard();
      
      let base64_str = base64_encode(&bmp_file);
      return Ok(format!("data:image/bmp;base64,{}", base64_str));
    }

    CloseClipboard();
    Ok(String::new())
  }
}

#[cfg(target_os = "windows")]
fn set_clipboard_text(text: &str) -> Result<(), String> {
  unsafe {
    use windows_sys::Win32::System::DataExchange::{
      OpenClipboard, CloseClipboard, EmptyClipboard, SetClipboardData
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GlobalFree, GMEM_MOVEABLE};

    if OpenClipboard(0) == 0 {
      return Err("Failed to open clipboard".into());
    }
    EmptyClipboard();

    if text.starts_with("data:image/bmp;base64,") || text.starts_with("data:image/png;base64,") {
      let comma_idx = text.find(',').unwrap_or(0);
      let base64_part = &text[comma_idx + 1..];
      if let Some(bmp_bytes) = base64_decode(base64_part) {
        if bmp_bytes.len() > 14 && &bmp_bytes[0..2] == b"BM" {
          let dib_bytes = &bmp_bytes[14..];
          let handle = GlobalAlloc(0x0002, dib_bytes.len()); // GMEM_MOVEABLE = 0x0002
          if handle.is_null() {
            CloseClipboard();
            return Err("Failed to allocate global memory".into());
          }
          let ptr = GlobalLock(handle);
          if ptr.is_null() {
            GlobalFree(handle);
            CloseClipboard();
            return Err("Failed to lock global memory".into());
          }
          std::ptr::copy_nonoverlapping(dib_bytes.as_ptr(), ptr as *mut u8, dib_bytes.len());
          GlobalUnlock(handle);
          
          if SetClipboardData(8, handle).is_null() { // CF_DIB = 8
            GlobalFree(handle);
            CloseClipboard();
            return Err("Failed to set clipboard DIB data".into());
          }
        }
      }
      CloseClipboard();
      return Ok(());
    }

    let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes_len = utf16.len() * 2;
    let handle = GlobalAlloc(0x0002, bytes_len); // GMEM_MOVEABLE = 0x0002
    if handle.is_null() {
      CloseClipboard();
      return Err("Failed to allocate global memory".into());
    }
    let ptr = GlobalLock(handle);
    if ptr.is_null() {
      GlobalFree(handle);
      CloseClipboard();
      return Err("Failed to lock allocated global memory".into());
    }
    std::ptr::copy_nonoverlapping(utf16.as_ptr(), ptr as *mut u16, utf16.len());
    GlobalUnlock(handle);

    if SetClipboardData(13, handle).is_null() { // CF_UNICODETEXT = 13
      GlobalFree(handle);
      CloseClipboard();
      return Err("Failed to set clipboard data".into());
    }

    CloseClipboard();
    Ok(())
  }
}

#[tauri::command]
fn enumerate_windows() -> Vec<WindowInfo> {
  #[cfg(target_os = "windows")]
  {
    let mut list: Vec<WindowInfo> = Vec::new();
    unsafe {
      EnumWindows(Some(enum_windows_callback), &mut list as *mut _ as LPARAM);
    }
    list
  }

  #[cfg(target_os = "macos")]
  {
    enumerate_macos_windows()
  }

  #[cfg(target_os = "linux")]
  {
    enumerate_x11_windows()
  }

  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  {
    vec![
      WindowInfo { handle: 1001, title: "Mock IDE - main.rs".into() },
      WindowInfo { handle: 1002, title: "Mock Document.pdf".into() },
      WindowInfo { handle: 1003, title: "Mock Browser - Omni-Space".into() },
    ]
  }
}

#[tauri::command]
fn start_tracking_window(app_handle: tauri::AppHandle, handle: usize) {
  stop_tracking_window();

  if let Ok(mut lock) = TARGET_HWND.lock() {
    *lock = Some(handle);
  }
  if let Ok(mut lock) = TAURI_APP.lock() {
    *lock = Some(app_handle.clone());
  }

  IS_TRACKING.store(true, Ordering::SeqCst);

  #[cfg(target_os = "windows")]
  {
    let (tx, rx) = std::sync::mpsc::channel::<(u32, isize)>();

    let join_handle = std::thread::spawn(move || {
      let thread_id = unsafe { GetCurrentThreadId() };

      let hook = unsafe {
        SetWinEventHook(
          EVENT_OBJECT_DESTROY,
          EVENT_OBJECT_LOCATIONCHANGE,
          std::ptr::null_mut(),
          Some(win_event_proc),
          0,
          0,
          WINEVENT_OUTOFCONTEXT,
        )
      };

      if hook != 0 {
        tx.send((thread_id, hook as isize)).unwrap_or(());

        let mut msg = MSG {
          hwnd: std::ptr::null_mut(),
          message: 0,
          wParam: 0,
          lParam: 0,
          time: 0,
          pt: windows_sys::Win32::Foundation::POINT { x: 0, y: 0 },
        };

        unsafe {
          while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
          }
          UnhookWinEvent(hook);
        }
      }

      if let Ok(mut state_lock) = TRACKING_STATE.lock() {
        if let Some(state) = &*state_lock {
          if state.thread_id == thread_id {
            *state_lock = None;
          }
        }
      }
    });

    if let Ok((thread_id, hook_handle)) = rx.recv_timeout(Duration::from_millis(1000)) {
      if let Ok(mut state_lock) = TRACKING_STATE.lock() {
        *state_lock = Some(TrackingState {
          thread_id,
          hook_handle,
        });
      }
      if let Ok(mut join_lock) = JOIN_HANDLE.lock() {
        *join_lock = Some(join_handle);
      }
    }
  }

  #[cfg(target_os = "macos")]
  {
    let join_handle = std::thread::spawn(move || {
      let mut x = 200;
      let mut y = 200;
      let mut direction = 1;
      
      while IS_TRACKING.load(Ordering::SeqCst) {
        x += 2 * direction;
        if x > 500 || x < 100 {
          direction *= -1;
        }
        app_handle.emit_all("native-window-bounds", BoundsPayload {
          handle,
          x,
          y,
          width: 800,
          height: 600,
        }).ok();

        std::thread::sleep(Duration::from_millis(200));
      }
    });

    if let Ok(mut join_lock) = JOIN_HANDLE.lock() {
      *join_lock = Some(join_handle);
    }
  }

  #[cfg(target_os = "linux")]
  {
    let join_handle = std::thread::spawn(move || {
      track_window_position_linux(app_handle, handle);
    });

    if let Ok(mut join_lock) = JOIN_HANDLE.lock() {
      *join_lock = Some(join_handle);
    }
  }

  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  {
    let join_handle = std::thread::spawn(move || {
      let mut x = 200;
      let mut y = 200;
      let mut direction = 1;
      
      while IS_TRACKING.load(Ordering::SeqCst) {
        x += 2 * direction;
        if x > 500 || x < 100 {
          direction *= -1;
        }
        app_handle.emit_all("native-window-bounds", BoundsPayload {
          handle,
          x,
          y,
          width: 800,
          height: 600,
        }).ok();

        std::thread::sleep(Duration::from_millis(200));
      }
    });

    if let Ok(mut join_lock) = JOIN_HANDLE.lock() {
      *join_lock = Some(join_handle);
    }
  }
}

#[tauri::command]
fn stop_tracking_window() {
  IS_TRACKING.store(false, Ordering::SeqCst);

  #[cfg(target_os = "linux")]
  {
    let mut dev_lock = UINPUT_DEVICE.lock().unwrap();
    *dev_lock = None;
  }

  #[cfg(target_os = "windows")]
  {
    let state = {
      if let Ok(mut lock) = TRACKING_STATE.lock() {
        lock.take()
      } else {
        None
      }
    };

    if let Some(state) = state {
      unsafe {
        PostThreadMessageW(state.thread_id, WM_QUIT, 0, 0);
      }
    }
  }

  let join_handle = {
    if let Ok(mut lock) = JOIN_HANDLE.lock() {
      lock.take()
    } else {
      None
    }
  };

  if let Some(handle) = join_handle {
    handle.join().ok();
  }

  if let Ok(mut lock) = TARGET_HWND.lock() {
    *lock = None;
  }
  if let Ok(mut lock) = TAURI_APP.lock() {
    *lock = None;
  }
}

#[tauri::command]
fn inject_input(event: String) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    if let Ok(parsed) = serde_json::from_str::<InputEventPayload>(&event) {
      match parsed {
        InputEventPayload::Mousemove(p) => {
          inject_mouse_event(MOUSEEVENTF_MOVE, p.x, p.y, 0);
        }
        InputEventPayload::Mousedown(p) => {
          let flags = match p.button {
            0 => MOUSEEVENTF_LEFTDOWN,
            1 => MOUSEEVENTF_MIDDLEDOWN,
            2 => MOUSEEVENTF_RIGHTDOWN,
            _ => 0,
          };
          if flags != 0 {
            inject_mouse_event(flags, p.x, p.y, 0);
          }
        }
        InputEventPayload::Mouseup(p) => {
          let flags = match p.button {
            0 => MOUSEEVENTF_LEFTUP,
            1 => MOUSEEVENTF_MIDDLEUP,
            2 => MOUSEEVENTF_RIGHTUP,
            _ => 0,
          };
          if flags != 0 {
            inject_mouse_event(flags, p.x, p.y, 0);
          }
        }
        InputEventPayload::Scroll(p) => {
          inject_scroll_event(p.x, p.y, p.delta_x, p.delta_y);
        }
        InputEventPayload::Keydown(p) => {
          inject_key_event(&p.code, false);
        }
        InputEventPayload::Keyup(p) => {
          inject_key_event(&p.code, true);
        }
      }
    }
    Ok(())
  }

  #[cfg(target_os = "macos")]
  {
    if let Ok(parsed) = serde_json::from_str::<InputEventPayload>(&event) {
      inject_input_macos(&parsed);
    }
    Ok(())
  }

  #[cfg(target_os = "linux")]
  {
    if let Ok(parsed) = serde_json::from_str::<InputEventPayload>(&event) {
      inject_input_linux(&parsed)
    } else {
      Err("Failed to parse input event payload".into())
    }
  }

  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  {
    println!("Mock inject_input: {}", event);
    Ok(())
  }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGPoint {
  x: f64,
  y: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGSize {
  width: f64,
  height: f64,
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct CGRect {
  origin: CGPoint,
  size: CGSize,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
  fn AXIsProcessTrusted() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
  fn CGPreflightScreenCaptureAccess() -> bool;
  fn CGRequestScreenCaptureAccess() -> bool;
  
  fn CGWindowListCopyWindowInfo(option: u32, relativeToWindow: u32) -> *const std::ffi::c_void;

  fn CGWindowListCreateImage(
    screenBounds: CGRect,
    listOption: u32,
    windowID: u32,
    imageOption: u32,
  ) -> *const std::ffi::c_void;

  fn CGImageGetWidth(image: *const std::ffi::c_void) -> usize;
  fn CGImageGetHeight(image: *const std::ffi::c_void) -> usize;
  fn CGImageGetDataProvider(image: *const std::ffi::c_void) -> *const std::ffi::c_void;
  fn CGDataProviderCopyData(provider: *const std::ffi::c_void) -> *const std::ffi::c_void;

  fn CGEventCreateMouseEvent(
    source: *const std::ffi::c_void,
    mouseType: u32,
    mouseCursorPosition: CGPoint,
    mouseButton: u32,
  ) -> *const std::ffi::c_void;

  fn CGEventCreateScrollWheelEvent(
    source: *const std::ffi::c_void,
    units: u32,
    wheelCount: u32,
    wheel1: i32,
  ) -> *const std::ffi::c_void;

  fn CGEventCreateKeyboardEvent(
    source: *const std::ffi::c_void,
    virtualKey: u16,
    keyDown: bool,
  ) -> *const std::ffi::c_void;

  fn CGEventPost(tap: u32, event: *const std::ffi::c_void);
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
  fn CFRelease(cf: *const std::ffi::c_void);
  fn CFArrayGetCount(array: *const std::ffi::c_void) -> isize;
  fn CFArrayGetValueAtIndex(array: *const std::ffi::c_void, index: isize) -> *const std::ffi::c_void;
  fn CFDictionaryGetValue(theDict: *const std::ffi::c_void, key: *const std::ffi::c_void) -> *const std::ffi::c_void;
  fn CFNumberGetValue(number: *const std::ffi::c_void, theType: isize, valuePtr: *mut std::ffi::c_void) -> bool;
  fn CFStringGetCString(theString: *const std::ffi::c_void, buffer: *mut u8, bufferSize: isize, encoding: u32) -> bool;
  fn CFStringCreateWithCString(alloc: *const std::ffi::c_void, cStr: *const u8, encoding: u32) -> *const std::ffi::c_void;
  fn CFDataGetBytePtr(data: *const std::ffi::c_void) -> *const u8;
  fn CFDataGetLength(data: *const std::ffi::c_void) -> isize;
}

#[cfg(target_os = "macos")]
#[link(name = "objc")]
extern "C" {
  fn objc_getClass(name: *const u8) -> *mut std::ffi::c_void;
  fn sel_registerName(name: *const u8) -> *mut std::ffi::c_void;
  fn objc_msgSend();
}

#[cfg(target_os = "macos")]
struct SafeCGImage {
  image: *const std::ffi::c_void,
}

#[cfg(target_os = "macos")]
impl Drop for SafeCGImage {
  fn drop(&mut self) {
    if !self.image.is_null() {
      unsafe {
        CFRelease(self.image);
      }
    }
  }
}

#[cfg(target_os = "macos")]
struct SafeCFRef(*const std::ffi::c_void);

#[cfg(target_os = "macos")]
impl Drop for SafeCFRef {
  fn drop(&mut self) {
    if !self.0.is_null() {
      unsafe {
        CFRelease(self.0);
      }
    }
  }
}

#[cfg(target_os = "macos")]
unsafe fn get_cf_number(dict: *const std::ffi::c_void, key_name: &str) -> Option<i64> {
  let c_str = format!("{}\0", key_name);
  let key_str = CFStringCreateWithCString(std::ptr::null(), c_str.as_ptr(), 0x08000100); // UTF8 encoding = 0x08000100
  if key_str.is_null() { return None; }
  let val = CFDictionaryGetValue(dict, key_str);
  CFRelease(key_str);
  if val.is_null() { return None; }
  let mut num: i64 = 0;
  if CFNumberGetValue(val, 4, &mut num as *mut i64 as *mut std::ffi::c_void) { // kCFNumberSInt64Type = 4
    Some(num)
  } else {
    None
  }
}

#[cfg(target_os = "macos")]
unsafe fn get_cf_string(dict: *const std::ffi::c_void, key_name: &str) -> Option<String> {
  let c_str = format!("{}\0", key_name);
  let key_str = CFStringCreateWithCString(std::ptr::null(), c_str.as_ptr(), 0x08000100);
  if key_str.is_null() { return None; }
  let val = CFDictionaryGetValue(dict, key_str);
  CFRelease(key_str);
  if val.is_null() { return None; }
  
  let mut buf = vec![0u8; 512];
  if CFStringGetCString(val, buf.as_mut_ptr(), 512, 0x08000100) {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(512);
    Some(String::from_utf8_lossy(&buf[..len]).to_string())
  } else {
    None
  }
}

#[cfg(target_os = "macos")]
fn enumerate_macos_windows() -> Vec<WindowInfo> {
  let mut list = Vec::new();
  unsafe {
    let array = CGWindowListCopyWindowInfo(0, 0); // kCGWindowListOptionAll = 0
    if !array.is_null() {
      let count = CFArrayGetCount(array);
      for i in 0..count {
        let dict = CFArrayGetValueAtIndex(array, i);
        if !dict.is_null() {
          if let Some(layer) = get_cf_number(dict, "kCGWindowLayer") {
            if layer == 0 {
              let handle = get_cf_number(dict, "kCGWindowNumber").unwrap_or(0) as usize;
              let name = get_cf_string(dict, "kCGWindowName").unwrap_or_default();
              let owner = get_cf_string(dict, "kCGWindowOwnerName").unwrap_or_default();
              
              let title = if name.is_empty() {
                owner
              } else {
                format!("{} ({})", name, owner)
              };

              if !title.trim().is_empty() && handle > 0 {
                list.push(WindowInfo {
                  handle,
                  title,
                });
              }
            }
          }
        }
      }
      CFRelease(array);
    }
  }
  list
}

#[cfg(target_os = "macos")]
fn encode_bmp(width: u32, height: u32, bgra: &[u8]) -> Vec<u8> {
  let mut bmp = Vec::with_capacity(14 + 40 + bgra.len());
  let file_size = (14 + 40 + bgra.len()) as u32;
  
  // File Header
  bmp.extend_from_slice(b"BM");
  bmp.extend_from_slice(&file_size.to_le_bytes());
  bmp.extend_from_slice(&[0, 0, 0, 0]);
  bmp.extend_from_slice(&54u32.to_le_bytes());
  
  // DIB Header
  bmp.extend_from_slice(&40u32.to_le_bytes());
  bmp.extend_from_slice(&(width as i32).to_le_bytes());
  bmp.extend_from_slice(&(-(height as i32)).to_le_bytes()); // top-down
  bmp.extend_from_slice(&1u16.to_le_bytes());
  bmp.extend_from_slice(&32u16.to_le_bytes());
  bmp.extend_from_slice(&0u32.to_le_bytes());
  bmp.extend_from_slice(&(bgra.len() as u32).to_le_bytes());
  bmp.extend_from_slice(&0i32.to_le_bytes());
  bmp.extend_from_slice(&0i32.to_le_bytes());
  bmp.extend_from_slice(&0u32.to_le_bytes());
  bmp.extend_from_slice(&0u32.to_le_bytes());
  
  bmp.extend_from_slice(bgra);
  bmp
}

#[cfg(target_os = "macos")]
fn capture_window_bmp(window_id: u32) -> Option<Vec<u8>> {
  unsafe {
    let cg_rect_null = CGRect {
      origin: CGPoint { x: 0.0, y: 0.0 },
      size: CGSize { width: 0.0, height: 0.0 },
    };
    let image_ref = CGWindowListCreateImage(cg_rect_null, 8, window_id, 0); // IncludingWindow = 8
    if image_ref.is_null() {
      return None;
    }
    let image = SafeCGImage { image: image_ref };

    let width = CGImageGetWidth(image.image) as u32;
    let height = CGImageGetHeight(image.image) as u32;
    if width == 0 || height == 0 {
      return None;
    }

    let provider = CGImageGetDataProvider(image.image);
    if provider.is_null() {
      return None;
    }

    let data_ref = CGDataProviderCopyData(provider);
    if data_ref.is_null() {
      return None;
    }
    let data = SafeCFRef(data_ref);

    let len = CFDataGetLength(data.0) as usize;
    let ptr = CFDataGetBytePtr(data.0);
    if ptr.is_null() || len == 0 {
      return None;
    }

    let slice = std::slice::from_raw_parts(ptr, len);

    // Downscale threshold check (1280x720) preserving aspect ratio
    if width > 1280 || height > 720 {
      let scale_x = width as f64 / 1280.0;
      let scale_y = height as f64 / 720.0;
      let scale = scale_x.max(scale_y);

      let new_width = (width as f64 / scale) as u32;
      let new_height = (height as f64 / scale) as u32;

      let mut downscaled = vec![0u8; (new_width * new_height * 4) as usize];
      for y in 0..new_height {
        let orig_y = ((y as f64 * scale) as u32).min(height - 1);
        for x in 0..new_width {
          let orig_x = ((x as f64 * scale) as u32).min(width - 1);
          let orig_idx = ((orig_y * width + orig_x) * 4) as usize;
          let dest_idx = ((y * new_width + x) * 4) as usize;
          downscaled[dest_idx..dest_idx + 4].copy_from_slice(&slice[orig_idx..orig_idx + 4]);
        }
      }
      Some(encode_bmp(new_width, new_height, &downscaled))
    } else {
      Some(encode_bmp(width, height, slice))
    }
  }
}

#[cfg(target_os = "macos")]
fn code_to_mac_keycode(code: &str) -> u16 {
  match code {
    "KeyA" => 0,
    "KeyS" => 1,
    "KeyD" => 2,
    "KeyF" => 3,
    "KeyH" => 4,
    "KeyG" => 5,
    "KeyZ" => 6,
    "KeyX" => 7,
    "KeyC" => 8,
    "KeyV" => 9,
    "KeyB" => 11,
    "KeyQ" => 12,
    "KeyW" => 13,
    "KeyE" => 14,
    "KeyR" => 15,
    "KeyY" => 16,
    "KeyT" => 17,
    "Digit1" => 18,
    "Digit2" => 19,
    "Digit3" => 20,
    "Digit4" => 21,
    "Digit6" => 22,
    "Digit5" => 23,
    "Equal" => 24,
    "Digit9" => 25,
    "Digit7" => 26,
    "Minus" => 27,
    "Digit8" => 28,
    "Digit0" => 29,
    "BracketRight" => 30,
    "KeyO" => 31,
    "KeyU" => 32,
    "BracketLeft" => 33,
    "KeyI" => 34,
    "KeyP" => 35,
    "Enter" => 36,
    "KeyL" => 37,
    "KeyJ" => 38,
    "Quote" => 39,
    "KeyK" => 40,
    "Semicolon" => 41,
    "Backslash" => 42,
    "Comma" => 43,
    "Slash" => 44,
    "KeyN" => 45,
    "KeyM" => 46,
    "Period" => 47,
    "Tab" => 48,
    "Space" => 49,
    "Backquote" => 50,
    "Backspace" => 51,
    "Escape" => 53,
    "ControlLeft" => 59,
    "ShiftLeft" => 56,
    "AltLeft" => 58,
    "ArrowUp" => 126,
    "ArrowDown" => 125,
    "ArrowLeft" => 123,
    "ArrowRight" => 124,
    _ => 999,
  }
}

#[cfg(target_os = "macos")]
fn inject_input_macos(event: &InputEventPayload) {
  unsafe {
    if !AXIsProcessTrusted() {
      // Graceful no-op on macOS if accessibility permission is denied
      return;
    }

    match event {
      InputEventPayload::Mousemove(p) => {
        let pos = CGPoint { x: p.x as f64, y: p.y as f64 };
        let ev = CGEventCreateMouseEvent(std::ptr::null(), 5, pos, 0); // 5 = kCGEventMouseMoved
        if !ev.is_null() {
          CGEventPost(0, ev);
          CFRelease(ev);
        }
      }
      InputEventPayload::Mousedown(p) => {
        let pos = CGPoint { x: p.x as f64, y: p.y as f64 };
        let mouse_type = match p.button {
          0 => 1, // kCGEventLeftMouseDown
          2 => 3, // kCGEventRightMouseDown
          _ => 25, // kCGEventOtherMouseDown
        };
        let button = match p.button {
          0 => 0,
          2 => 1,
          _ => 2,
        };
        let ev = CGEventCreateMouseEvent(std::ptr::null(), mouse_type, pos, button);
        if !ev.is_null() {
          CGEventPost(0, ev);
          CFRelease(ev);
        }
      }
      InputEventPayload::Mouseup(p) => {
        let pos = CGPoint { x: p.x as f64, y: p.y as f64 };
        let mouse_type = match p.button {
          0 => 2, // kCGEventLeftMouseUp
          2 => 4, // kCGEventRightMouseUp
          _ => 26, // kCGEventOtherMouseUp
        };
        let button = match p.button {
          0 => 0,
          2 => 1,
          _ => 2,
        };
        let ev = CGEventCreateMouseEvent(std::ptr::null(), mouse_type, pos, button);
        if !ev.is_null() {
          CGEventPost(0, ev);
          CFRelease(ev);
        }
      }
      InputEventPayload::Scroll(p) => {
        let ev = CGEventCreateScrollWheelEvent(std::ptr::null(), 1, 1, p.delta_y as i32);
        if !ev.is_null() {
          CGEventPost(0, ev);
          CFRelease(ev);
        }
      }
      InputEventPayload::Keydown(p) => {
        let keycode = code_to_mac_keycode(&p.code);
        if keycode != 999 {
          let ev = CGEventCreateKeyboardEvent(std::ptr::null(), keycode, true);
          if !ev.is_null() {
            CGEventPost(0, ev);
            CFRelease(ev);
          }
        }
      }
      InputEventPayload::Keyup(p) => {
        let keycode = code_to_mac_keycode(&p.code);
        if keycode != 999 {
          let ev = CGEventCreateKeyboardEvent(std::ptr::null(), keycode, false);
          if !ev.is_null() {
            CGEventPost(0, ev);
            CFRelease(ev);
          }
        }
      }
    }
  }
}

#[cfg(target_os = "macos")]
fn get_clipboard_macos() -> Result<String, String> {
  unsafe {
    let pool_cls = objc_getClass("NSAutoreleasePool\0".as_ptr());
    let sel_alloc = sel_registerName("alloc\0".as_ptr());
    let sel_init = sel_registerName("init\0".as_ptr());
    let msg_send: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());
    let pool = msg_send(msg_send(pool_cls, sel_alloc), sel_init);

    let drain_and_return = |res: Result<String, String>| {
      let sel_drain = sel_registerName("drain\0".as_ptr());
      let msg_send_void: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) = std::mem::transmute(objc_msgSend as *const ());
      msg_send_void(pool, sel_drain);
      res
    };

    let cls_pasteboard = objc_getClass("NSPasteboard\0".as_ptr());
    let sel_general = sel_registerName("generalPasteboard\0".as_ptr());
    let pb = msg_send(cls_pasteboard, sel_general);
    if pb.is_null() {
      return drain_and_return(Err("Failed to get general pasteboard".into()));
    }

    let cls_string = objc_getClass("NSString\0".as_ptr());
    let sel_string_with_utf8 = sel_registerName("stringWithUTF8String:\0".as_ptr());
    let msg_send_utf8: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *const u8) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());
    
    let type_text = msg_send_utf8(cls_string, sel_string_with_utf8, "public.utf8-plain-text\0".as_ptr());
    let type_png = msg_send_utf8(cls_string, sel_string_with_utf8, "public.png\0".as_ptr());

    let sel_data_for_type = sel_registerName("dataForType:\0".as_ptr());
    let msg_send_data: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());
    
    let png_data = msg_send_data(pb, sel_data_for_type, type_png);
    if !png_data.is_null() {
      let sel_length = sel_registerName("length\0".as_ptr());
      let msg_send_len: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> usize = std::mem::transmute(objc_msgSend as *const ());
      let len = msg_send_len(png_data, sel_length);
      if len > 0 {
        let sel_bytes = sel_registerName("bytes\0".as_ptr());
        let msg_send_bytes: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> *const u8 = std::mem::transmute(objc_msgSend as *const ());
        let bytes = msg_send_bytes(png_data, sel_bytes);
        if !bytes.is_null() {
          let slice = std::slice::from_raw_parts(bytes, len);
          let base64_str = base64_encode(slice);
          return drain_and_return(Ok(format!("data:image/png;base64,{}", base64_str)));
        }
      }
    }

    let sel_string_for_type = sel_registerName("stringForType:\0".as_ptr());
    let msg_send_str: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());
    let ns_string = msg_send_str(pb, sel_string_for_type, type_text);
    if ns_string.is_null() {
      return drain_and_return(Ok(String::new()));
    }

    let sel_utf8 = sel_registerName("UTF8String\0".as_ptr());
    let msg_send_utf8_ptr: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> *const u8 = std::mem::transmute(objc_msgSend as *const ());
    let ptr = msg_send_utf8_ptr(ns_string, sel_utf8);
    if ptr.is_null() {
      return drain_and_return(Ok(String::new()));
    }

    let c_str = std::ffi::CStr::from_ptr(ptr as *const i8);
    let text = c_str.to_string_lossy().into_owned();
    drain_and_return(Ok(text))
  }
}

#[cfg(target_os = "macos")]
fn set_clipboard_macos(text: &str) -> Result<(), String> {
  unsafe {
    let pool_cls = objc_getClass("NSAutoreleasePool\0".as_ptr());
    let sel_alloc = sel_registerName("alloc\0".as_ptr());
    let sel_init = sel_registerName("init\0".as_ptr());
    let msg_send: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());
    let pool = msg_send(msg_send(pool_cls, sel_alloc), sel_init);

    let drain_and_return = |res: Result<(), String>| {
      let sel_drain = sel_registerName("drain\0".as_ptr());
      let msg_send_void: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void) = std::mem::transmute(objc_msgSend as *const ());
      msg_send_void(pool, sel_drain);
      res
    };

    let cls_pasteboard = objc_getClass("NSPasteboard\0".as_ptr());
    let sel_general = sel_registerName("generalPasteboard\0".as_ptr());
    let pb = msg_send(cls_pasteboard, sel_general);
    if pb.is_null() {
      return drain_and_return(Err("Failed to get general pasteboard".into()));
    }

    let cls_string = objc_getClass("NSString\0".as_ptr());
    let sel_string_with_utf8 = sel_registerName("stringWithUTF8String:\0".as_ptr());
    let msg_send_utf8: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *const u8) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());

    if text.starts_with("data:image/png;base64,") || text.starts_with("data:image/bmp;base64,") {
      let comma_idx = text.find(',').unwrap_or(0);
      let base64_part = &text[comma_idx + 1..];
      if let Some(png_bytes) = base64_decode(base64_part) {
        let type_png = msg_send_utf8(cls_string, sel_string_with_utf8, "public.png\0".as_ptr());
        
        let cls_array = objc_getClass("NSArray\0".as_ptr());
        let sel_array_with_object = sel_registerName("arrayWithObject:\0".as_ptr());
        let msg_send_array: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());
        let types_array = msg_send_array(cls_array, sel_array_with_object, type_png);
        
        let sel_declare_types = sel_registerName("declareTypes:owner:\0".as_ptr());
        let msg_send_declare: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void) = std::mem::transmute(objc_msgSend as *const ());
        msg_send_declare(pb, sel_declare_types, types_array, std::ptr::null_mut());

        let cls_data = objc_getClass("NSData\0".as_ptr());
        let sel_data_with_bytes = sel_registerName("dataWithBytes:length:\0".as_ptr());
        let msg_send_data_with_bytes: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *const u8, usize) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());
        let ns_data = msg_send_data_with_bytes(cls_data, sel_data_with_bytes, png_bytes.as_ptr(), png_bytes.len());

        let sel_set_data = sel_registerName("setData:forType:\0".as_ptr());
        let msg_send_set_data: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void) -> bool = std::mem::transmute(objc_msgSend as *const ());
        msg_send_set_data(pb, sel_set_data, ns_data, type_png);
      }
      return drain_and_return(Ok(()));
    }

    let null_terminated_text = format!("{}\0", text);
    let ns_text = msg_send_utf8(cls_string, sel_string_with_utf8, null_terminated_text.as_ptr());
    if ns_text.is_null() {
      return drain_and_return(Err("Failed to allocate NSString".into()));
    }

    let type_str = msg_send_utf8(cls_string, sel_string_with_utf8, "public.utf8-plain-text\0".as_ptr());
    if type_str.is_null() {
      return drain_and_return(Err("Failed to create NSPasteboardTypeString key".into()));
    }

    let cls_array = objc_getClass("NSArray\0".as_ptr());
    let sel_array_with_object = sel_registerName("arrayWithObject:\0".as_ptr());
    let msg_send_array: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());
    let types_array = msg_send_array(cls_array, sel_array_with_object, type_str);
    if types_array.is_null() {
      return drain_and_return(Err("Failed to create NSArray".into()));
    }

    let sel_declare_types = sel_registerName("declareTypes:owner:\0".as_ptr());
    let msg_send_declare: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void) = std::mem::transmute(objc_msgSend as *const ());
    msg_send_declare(pb, sel_declare_types, types_array, std::ptr::null_mut());

    let sel_set_string = sel_registerName("setString:forType:\0".as_ptr());
    let msg_send_set: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void, *mut std::ffi::c_void) -> bool = std::mem::transmute(objc_msgSend as *const ());
    if !msg_send_set(pb, sel_set_string, ns_text, type_str) {
      return drain_and_return(Err("Failed to set pasteboard string".into()));
    }

    drain_and_return(Ok(()))
  }
}

#[tauri::command]
fn get_clipboard() -> Result<String, String> {
  #[cfg(target_os = "windows")]
  {
    get_clipboard_text()
  }
  #[cfg(target_os = "macos")]
  {
    get_clipboard_macos()
  }
  #[cfg(target_os = "linux")]
  {
    get_clipboard_linux()
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  {
    Ok("Mock clipboard content".into())
  }
}

#[tauri::command]
fn set_clipboard(text: String) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    set_clipboard_text(&text)
  }
  #[cfg(target_os = "macos")]
  {
    set_clipboard_macos(&text)
  }
  #[cfg(target_os = "linux")]
  {
    set_clipboard_linux(&text)
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  {
    println!("Mock set_clipboard: {}", text);
    Ok(())
  }
}

#[tauri::command]
fn check_accessibility_permission() -> bool {
  #[cfg(target_os = "windows")]
  {
    true
  }
  #[cfg(target_os = "macos")]
  unsafe {
    AXIsProcessTrusted()
  }
  #[cfg(target_os = "linux")]
  {
    std::path::Path::new("/dev/uinput").exists() &&
    std::fs::OpenOptions::new().write(true).open("/dev/uinput").is_ok()
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  {
    true
  }
}

#[tauri::command]
fn request_accessibility_permission() {
  #[cfg(target_os = "macos")]
  {
    std::process::Command::new("open")
      .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
      .spawn()
      .ok();
  }
  #[cfg(target_os = "linux")]
  {
    println!("Linux input injection configuration requires read/write access to /dev/uinput.");
  }
}

#[tauri::command]
fn check_screen_recording_permission() -> bool {
  #[cfg(target_os = "windows")]
  {
    true
  }
  #[cfg(target_os = "macos")]
  unsafe {
    CGPreflightScreenCaptureAccess()
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  {
    true
  }
}

#[tauri::command]
fn request_screen_recording_permission() {
  #[cfg(target_os = "macos")]
  unsafe {
    CGRequestScreenCaptureAccess();
  }
}

#[tauri::command]
fn start_macos_capture(window_id: usize) -> Result<(u16, String), String> {
  stop_macos_capture();

  IS_CAPTURING_MACOS.store(true, Ordering::SeqCst);
  if let Ok(mut lock) = CAPTURE_WINDOW_ID.lock() {
    *lock = Some(window_id as u32);
  }

  #[cfg(target_os = "windows")]
  {
    IS_CAPTURING_AUDIO.store(true, Ordering::SeqCst);
    std::thread::spawn(run_wasapi_loopback);
  }

  // Generate cryptographically secure random session token via /dev/urandom
  let mut bytes = [0u8; 16];
  if let Ok(mut file) = std::fs::File::open("/dev/urandom") {
    file.read_exact(&mut bytes).ok();
  }
  let session_token: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
  
  if let Ok(mut lock) = CAPTURE_TOKEN.lock() {
    *lock = Some(session_token.clone());
  }

  // Bind TCP listener to dynamic localhost port
  let listener = std::net::TcpListener::bind("127.0.0.1:0")
    .map_err(|e| format!("Failed to bind TCP: {}", e))?;
  let port = listener.local_addr().unwrap().port();

  if let Ok(mut lock) = CAPTURE_PORT.lock() {
    *lock = Some(port);
  }

  listener.set_nonblocking(true).ok();

  let token_clone = session_token.clone();
  std::thread::spawn(move || {
    let mut client_stream = None;
    
    // Non-blocking wait loop for incoming webview HTTP client
    while IS_CAPTURING_MACOS.load(Ordering::SeqCst) {
      match listener.accept() {
        Ok((stream, _)) => {
          client_stream = Some(stream);
          break;
        }
        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
          std::thread::sleep(Duration::from_millis(100));
        }
        Err(_) => break,
      }
    }

    if let Some(mut stream) = client_stream {
      let mut buf = [0u8; 1024];
      let n = stream.read(&mut buf).unwrap_or(0);
      let request_text = String::from_utf8_lossy(&buf[..n]);

      // Validate session token parameter to secure loopback stream access
      let request_line = request_text.lines().next().unwrap_or("");
      let expected_param = format!("token={}", token_clone);
      if !request_line.contains(&expected_param) {
        let err_response = "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 12\r\n\r\nUnauthorized";
        stream.write_all(err_response.as_bytes()).ok();
        return;
      }

      if request_text.contains("GET /audio") {
        let headers = "HTTP/1.1 200 OK\r\nContent-Type: audio/l16;rate=48000;channels=2\r\nConnection: keep-alive\r\nCache-Control: no-cache\r\n\r\n";
        if stream.write_all(headers.as_bytes()).is_ok() {
          while IS_CAPTURING_MACOS.load(Ordering::SeqCst) {
            #[cfg(target_os = "windows")]
            {
              let samples = {
                if let Ok(mut buffer) = AUDIO_BUFFER.lock() {
                  std::mem::take(&mut *buffer)
                } else {
                  Vec::new()
                }
              };
              if !samples.is_empty() {
                if stream.write_all(&samples).is_err() {
                  break;
                }
              }
            }
            std::thread::sleep(Duration::from_millis(20));
          }
        }
        return;
      }

      // Write MJPEG multipart HTTP headers
      let headers = "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\nConnection: keep-alive\r\nCache-Control: no-cache\r\n\r\n";
      if stream.write_all(headers.as_bytes()).is_ok() {
        while IS_CAPTURING_MACOS.load(Ordering::SeqCst) {
          let win_id = {
            if let Ok(lock) = CAPTURE_WINDOW_ID.lock() {
              *lock
            } else {
              None
            }
          };

          if let Some(target_id) = win_id {
            if let Some(bmp_bytes) = capture_window_bmp(target_id) {
              let frame_header = format!(
                "--frame\r\nContent-Type: image/bmp\r\nContent-Length: {}\r\n\r\n",
                bmp_bytes.len()
              );
              if stream.write_all(frame_header.as_bytes()).is_err() {
                break;
              }
              if stream.write_all(&bmp_bytes).is_err() {
                break;
              }
              if stream.write_all(b"\r\n").is_err() {
                break;
              }
            }
          }
          std::thread::sleep(Duration::from_millis(33)); // ~30 fps
        }
      }
    }
  });

  Ok((port, session_token))
}

#[tauri::command]
fn stop_macos_capture() {
  IS_CAPTURING_MACOS.store(false, Ordering::SeqCst);
  #[cfg(target_os = "windows")]
  {
    IS_CAPTURING_AUDIO.store(false, Ordering::SeqCst);
  }
  if let Ok(mut lock) = CAPTURE_PORT.lock() {
    *lock = None;
  }
  if let Ok(mut lock) = CAPTURE_WINDOW_ID.lock() {
    *lock = None;
  }
  if let Ok(mut lock) = CAPTURE_TOKEN.lock() {
    *lock = None;
  }
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      enumerate_windows,
      start_tracking_window,
      stop_tracking_window,
      inject_input,
      get_clipboard,
      set_clipboard,
      check_accessibility_permission,
      request_accessibility_permission,
      check_screen_recording_permission,
      request_screen_recording_permission,
      start_macos_capture,
      stop_macos_capture,
      focus_native_window,
      stop_uinput_session
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// Linux-specific FFI and structures
#[cfg(target_os = "linux")]
#[link(name = "X11")]
extern "C" {
  fn XOpenDisplay(display_name: *const u8) -> *mut std::ffi::c_void;
  fn XCloseDisplay(display: *mut std::ffi::c_void) -> i32;
  fn XSelectInput(display: *mut std::ffi::c_void, w: u64, event_mask: i64) -> i32;
  fn XNextEvent(display: *mut std::ffi::c_void, event_return: *mut XEvent) -> i32;
  fn XPending(display: *mut std::ffi::c_void) -> i32;
  fn XTranslateCoordinates(
    display: *mut std::ffi::c_void,
    src_w: u64,
    dest_w: u64,
    src_x: i32,
    src_y: i32,
    dest_x_return: *mut i32,
    dest_y_return: *mut i32,
    child_return: *mut u64,
  ) -> bool;
  fn XGetWindowAttributes(
    display: *mut std::ffi::c_void,
    w: u64,
    window_attributes_return: *mut XWindowAttributes,
  ) -> i32;
  fn XDefaultRootWindow(display: *mut std::ffi::c_void) -> u64;
  fn XQueryTree(
    display: *mut std::ffi::c_void,
    w: u64,
    root_return: *mut u64,
    parent_return: *mut u64,
    children_return: *mut *mut u64,
    nchildren_return: *mut u32,
  ) -> i32;
  fn XFree(data: *mut std::ffi::c_void) -> i32;
  fn XFetchName(display: *mut std::ffi::c_void, w: u64, name_return: *mut *mut u8) -> i32;
  fn XGetImage(
    display: *mut std::ffi::c_void,
    d: u64,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    plane_mask: u64,
    format: i32,
  ) -> *mut XImage;
  fn XDestroyImage(image: *mut XImage) -> i32;
  fn XSetInputFocus(display: *mut std::ffi::c_void, focus: u64, revert_to: i32, time: u64) -> i32;

  fn XCreateSimpleWindow(
    display: *mut std::ffi::c_void,
    parent: u64,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    border_width: u32,
    border: u64,
    background: u64,
  ) -> u64;
  fn XDestroyWindow(display: *mut std::ffi::c_void, w: u64) -> i32;
  fn XInternAtom(display: *mut std::ffi::c_void, atom_name: *const u8, only_if_exists: bool) -> u64;
  fn XSetSelectionOwner(display: *mut std::ffi::c_void, selection: u64, owner: u64, time: u64) -> i32;
  fn XGetSelectionOwner(display: *mut std::ffi::c_void, selection: u64) -> u64;
  fn XChangeProperty(
    display: *mut std::ffi::c_void,
    w: u64,
    property: u64,
    r#type: u64,
    format: i32,
    mode: i32,
    data: *const u8,
    nelements: i32,
  ) -> i32;
  fn XSendEvent(
    display: *mut std::ffi::c_void,
    w: u64,
    propagate: bool,
    event_mask: i64,
    event_send: *mut XEvent,
  ) -> i32;
  fn XConvertSelection(
    display: *mut std::ffi::c_void,
    selection: u64,
    target: u64,
    property: u64,
    requestor: u64,
    time: u64,
  ) -> i32;
  fn XGetWindowProperty(
    display: *mut std::ffi::c_void,
    w: u64,
    property: u64,
    long_offset: i64,
    long_length: i64,
    delete: bool,
    req_type: u64,
    actual_type_return: *mut u64,
    actual_format_return: *mut i32,
    nitems_return: *mut u64,
    bytes_after_return: *mut u64,
    prop_return: *mut *mut u8,
  ) -> i32;
  fn ioctl(fd: i32, request: u64, ...) -> i32;
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct XWindowAttributes {
  x: i32,
  y: i32,
  width: i32,
  height: i32,
  border_width: i32,
  depth: i32,
  visual: *mut std::ffi::c_void,
  root: u64,
  class: i32,
  win_gravity: i32,
  backing_store: i32,
  backing_planes: u64,
  backing_pixel: u64,
  save_under: bool,
  colormap: u64,
  map_installed: bool,
  map_state: i32,
  all_event_masks: i64,
  your_event_mask: i64,
  do_not_propagate_mask: i64,
  override_redirect: bool,
  screen: *mut std::ffi::c_void,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct XConfigureEvent {
  r#type: i32,
  serial: u64,
  send_event: bool,
  display: *mut std::ffi::c_void,
  event: u64,
  window: u64,
  x: i32,
  y: i32,
  width: i32,
  height: i32,
  border_width: i32,
  above: u64,
  override_redirect: bool,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct XSelectionRequestEvent {
  r#type: i32,
  serial: u64,
  send_event: bool,
  display: *mut std::ffi::c_void,
  owner: u64,
  requestor: u64,
  selection: u64,
  target: u64,
  property: u64,
  time: u64,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct XSelectionEvent {
  r#type: i32,
  serial: u64,
  send_event: bool,
  display: *mut std::ffi::c_void,
  requestor: u64,
  selection: u64,
  target: u64,
  property: u64,
  time: u64,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct XClientMessageEvent {
  r#type: i32,
  serial: u64,
  send_event: bool,
  display: *mut std::ffi::c_void,
  window: u64,
  message_type: u64,
  format: i32,
  data: [i8; 20],
}

#[cfg(target_os = "linux")]
#[repr(C)]
union XEvent {
  r#type: i32,
  configure: XConfigureEvent,
  selection_request: XSelectionRequestEvent,
  selection: XSelectionEvent,
  client_message: XClientMessageEvent,
  pad: [i64; 24],
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct XImage {
  width: i32,
  height: i32,
  xoffset: i32,
  format: i32,
  data: *mut u8,
  byte_order: i32,
  bitmap_unit: i32,
  bitmap_bit_order: i32,
  bitmap_pad: i32,
  depth: i32,
  bytes_per_line: i32,
  bits_per_pixel: i32,
  red_mask: u64,
  green_mask: u64,
  blue_mask: u64,
  obdata: *mut std::ffi::c_void,
  funcs: ImageFuncs,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct ImageFuncs {
  create_image: *const std::ffi::c_void,
  destroy_image: *const std::ffi::c_void,
  get_pixel: *const std::ffi::c_void,
  put_pixel: *const std::ffi::c_void,
  sub_image: *const std::ffi::c_void,
  add_pixel: *const std::ffi::c_void,
}

#[cfg(target_os = "linux")]
lazy_static::lazy_static! {
  static ref CLIPBOARD_TEXT: Mutex<Option<String>> = Mutex::new(None);
  static ref CLIPBOARD_WINDOW: Mutex<Option<u64>> = Mutex::new(None);
  static ref CLIPBOARD_THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);
  static ref UINPUT_DEVICE: Mutex<Option<UinputDevice>> = Mutex::new(None);
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct UinputUserDev {
  name: [u8; 80],
  id: InputId,
  effects_max: u32,
  absmax: [i32; 64],
  absmin: [i32; 64],
  absfuzz: [i32; 64],
  absflat: [i32; 64],
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct InputId {
  bustype: u16,
  vendor: u16,
  product: u16,
  version: u16,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct InputEvent {
  time: TimeVal,
  r#type: u16,
  code: u16,
  value: i32,
}

#[cfg(target_os = "linux")]
#[repr(C)]
struct TimeVal {
  sec: i64,
  usec: i64,
}

#[cfg(target_os = "linux")]
const UI_SET_EVBIT: u64 = 1074025828;
#[cfg(target_os = "linux")]
const UI_SET_KEYBIT: u64 = 1074025829;
#[cfg(target_os = "linux")]
const UI_SET_RELBIT: u64 = 1074025830;
#[cfg(target_os = "linux")]
const UI_DEV_CREATE: u64 = 21761;
#[cfg(target_os = "linux")]
const UI_DEV_DESTROY: u64 = 21762;

#[cfg(target_os = "linux")]
struct UinputDevice {
  file: std::fs::File,
}

#[cfg(target_os = "linux")]
impl UinputDevice {
  fn new() -> Result<Self, String> {
    use std::os::unix::io::AsRawFd;
    let file = std::fs::OpenOptions::new()
      .write(true)
      .open("/dev/uinput")
      .map_err(|e| format!("uinput-permission-denied: {}", e))?;
    
    let fd = file.as_raw_fd();
    unsafe {
      ioctl(fd, UI_SET_EVBIT, 1); // EV_KEY
      ioctl(fd, UI_SET_EVBIT, 2); // EV_REL
      
      // Enable mouse buttons
      ioctl(fd, UI_SET_KEYBIT, 272); // BTN_LEFT
      ioctl(fd, UI_SET_KEYBIT, 273); // BTN_RIGHT
      ioctl(fd, UI_SET_KEYBIT, 274); // BTN_MIDDLE
      
      // Enable relative mouse axes and wheel
      ioctl(fd, UI_SET_RELBIT, 0); // REL_X
      ioctl(fd, UI_SET_RELBIT, 1); // REL_Y
      ioctl(fd, UI_SET_RELBIT, 8); // REL_WHEEL
      
      // Enable keyboard keys
      for key in 1..248 {
        ioctl(fd, UI_SET_KEYBIT, key);
      }

      let mut dev: UinputUserDev = std::mem::zeroed();
      dev.name[..10].copy_from_slice(b"omni-input\0");
      dev.id = InputId {
        bustype: 0x03, // BUS_USB
        vendor: 0x1234,
        product: 0x5678,
        version: 1,
      };

      let dev_ptr = &dev as *const UinputUserDev as *const u8;
      let dev_size = std::mem::size_of::<UinputUserDev>();
      let slice = std::slice::from_raw_parts(dev_ptr, dev_size);
      
      use std::io::Write;
      let mut file_clone = file.try_clone().unwrap();
      file_clone.write_all(slice).map_err(|e| e.to_string())?;

      if ioctl(fd, UI_DEV_CREATE) < 0 {
        return Err("Failed to create uinput device".into());
      }
    }

    Ok(Self { file })
  }

  fn write_event(&mut self, r#type: u16, code: u16, value: i32) {
    use std::io::Write;
    unsafe {
      let ev = InputEvent {
        time: TimeVal { sec: 0, usec: 0 },
        r#type,
        code,
        value,
      };
      let ptr = &ev as *const InputEvent as *const u8;
      let len = std::mem::size_of::<InputEvent>();
      let slice = std::slice::from_raw_parts(ptr, len);
      self.file.write_all(slice).ok();
      
      // EV_SYN
      let syn = InputEvent {
        time: TimeVal { sec: 0, usec: 0 },
        r#type: 0,
        code: 0,
        value: 0,
      };
      let syn_ptr = &syn as *const InputEvent as *const u8;
      self.file.write_all(std::slice::from_raw_parts(syn_ptr, len)).ok();
    }
  }
}

#[cfg(target_os = "linux")]
impl Drop for UinputDevice {
  fn drop(&mut self) {
    use std::os::unix::io::AsRawFd;
    unsafe {
      ioctl(self.file.as_raw_fd(), UI_DEV_DESTROY);
    }
  }
}

#[cfg(target_os = "linux")]
fn code_to_linux_keycode(code: &str) -> u16 {
  match code {
    "KeyA" => 30, "KeyB" => 48, "KeyC" => 46, "KeyD" => 32, "KeyE" => 18,
    "KeyF" => 33, "KeyG" => 34, "KeyH" => 35, "KeyI" => 23, "KeyJ" => 36,
    "KeyK" => 37, "KeyL" => 38, "KeyM" => 50, "KeyN" => 49, "KeyO" => 24,
    "KeyP" => 25, "KeyQ" => 16, "KeyR" => 19, "KeyS" => 31, "KeyT" => 20,
    "KeyU" => 22, "KeyV" => 47, "KeyW" => 17, "KeyX" => 45, "KeyY" => 21,
    "KeyZ" => 44,
    "Digit1" => 2, "Digit2" => 3, "Digit3" => 4, "Digit4" => 5,
    "Digit5" => 6, "Digit6" => 7, "Digit7" => 8, "Digit8" => 9,
    "Digit9" => 10, "Digit0" => 11,
    "Enter" => 28, "Escape" => 1, "Backspace" => 14, "Tab" => 15, "Space" => 57,
    "Minus" => 12, "Equal" => 13, "BracketLeft" => 26, "BracketRight" => 27,
    "Backslash" => 43, "Semicolon" => 39, "Quote" => 40, "Backquote" => 41,
    "Comma" => 51, "Period" => 52, "Slash" => 53,
    "ShiftLeft" => 42, "ShiftRight" => 54, "ControlLeft" => 29, "AltLeft" => 56,
    "ArrowUp" => 103, "ArrowDown" => 108, "ArrowLeft" => 105, "ArrowRight" => 106,
    _ => 0,
  }
}

#[cfg(target_os = "linux")]
fn inject_input_linux(event: &InputEventPayload) -> Result<(), String> {
  let mut dev_lock = UINPUT_DEVICE.lock().unwrap();
  if dev_lock.is_none() {
    *dev_lock = Some(UinputDevice::new()?);
  }
  
  if let Some(dev) = &mut *dev_lock {
    match event {
      InputEventPayload::Mousemove(p) => {
        static mut LAST_X: i32 = 0;
        static mut LAST_Y: i32 = 0;
        unsafe {
          if LAST_X == 0 && LAST_Y == 0 {
            LAST_X = p.x;
            LAST_Y = p.y;
          }
          let dx = p.x - LAST_X;
          let dy = p.y - LAST_Y;
          LAST_X = p.x;
          LAST_Y = p.y;
          if dx != 0 {
            dev.write_event(2, 0, dx); // EV_REL, REL_X
          }
          if dy != 0 {
            dev.write_event(2, 1, dy); // EV_REL, REL_Y
          }
        }
      }
      InputEventPayload::Mousedown(p) => {
        let code = match p.button {
          0 => 272, // BTN_LEFT
          2 => 273, // BTN_RIGHT
          _ => 274, // BTN_MIDDLE
        };
        dev.write_event(1, code, 1); // EV_KEY, BTN_*, 1 = down
      }
      InputEventPayload::Mouseup(p) => {
        let code = match p.button {
          0 => 272,
          2 => 273,
          _ => 274,
        };
        dev.write_event(1, code, 0); // EV_KEY, BTN_*, 0 = up
      }
      InputEventPayload::Scroll(p) => {
        let val = if p.delta_y > 0.0 { -1 } else if p.delta_y < 0.0 { 1 } else { 0 };
        if val != 0 {
          dev.write_event(2, 8, val); // EV_REL, REL_WHEEL
        }
      }
      InputEventPayload::Keydown(p) => {
        let key = code_to_linux_keycode(&p.code);
        if key != 0 {
          dev.write_event(1, key, 1); // EV_KEY, key, 1 = down
        }
      }
      InputEventPayload::Keyup(p) => {
        let key = code_to_linux_keycode(&p.code);
        if key != 0 {
          dev.write_event(1, key, 0); // EV_KEY, key, 0 = up
        }
      }
    }
  }
  Ok(())
}

#[cfg(target_os = "linux")]
fn ensure_clipboard_initialized() {
  let mut win_lock = CLIPBOARD_WINDOW.lock().unwrap();
  if win_lock.is_none() {
    let (tx, rx) = std::sync::mpsc::channel::<u64>();
    let handle = std::thread::spawn(move || {
      unsafe {
        let display = XOpenDisplay(std::ptr::null());
        if display.is_null() { return; }
        let root = XDefaultRootWindow(display);
        let win = XCreateSimpleWindow(display, root, 0, 0, 1, 1, 0, 0, 0);
        tx.send(win).ok();
        
        let clipboard_atom = XInternAtom(display, "CLIPBOARD\0".as_ptr(), false);
        let utf8_atom = XInternAtom(display, "UTF8_STRING\0".as_ptr(), false);
        
        loop {
          let mut event: XEvent = std::mem::zeroed();
          XNextEvent(display, &mut event);
          if event.r#type == 30 { // SelectionRequest
            let req = event.selection_request;
            if req.selection == clipboard_atom {
              let text = CLIPBOARD_TEXT.lock().unwrap().clone().unwrap_or_default();
              XChangeProperty(
                display,
                req.requestor,
                req.property,
                utf8_atom,
                8,
                0,
                text.as_ptr(),
                text.len() as i32,
              );
              let mut response: XEvent = std::mem::zeroed();
              response.selection = XSelectionEvent {
                r#type: 31, // SelectionNotify
                serial: 0,
                send_event: true,
                display,
                requestor: req.requestor,
                selection: req.selection,
                target: req.target,
                property: req.property,
                time: req.time,
              };
              XSendEvent(display, req.requestor, false, 0, &mut response);
            }
          } else if event.r#type == 33 { // ClientMessage (destruction signal)
            break;
          }
        }
        
        XDestroyWindow(display, win);
        XCloseDisplay(display);
      }
    });
    
    if let Ok(win) = rx.recv_timeout(Duration::from_millis(1000)) {
      *win_lock = Some(win);
      let mut thread_lock = CLIPBOARD_THREAD.lock().unwrap();
      *thread_lock = Some(handle);
    }
  }
}

#[cfg(target_os = "linux")]
fn get_clipboard_linux() -> Result<String, String> {
  ensure_clipboard_initialized();
  let win = match *CLIPBOARD_WINDOW.lock().unwrap() {
    Some(w) => w,
    None => return Err("Clipboard window uninitialized".into()),
  };
  
  unsafe {
    let display = XOpenDisplay(std::ptr::null());
    if display.is_null() { return Err("Failed to open X11 display".into()); }
    
    let clipboard_atom = XInternAtom(display, "CLIPBOARD\0".as_ptr(), false);
    let utf8_atom = XInternAtom(display, "UTF8_STRING\0".as_ptr(), false);
    let target_prop = XInternAtom(display, "OMNI_CLIP_PROP\0".as_ptr(), false);
    
    XConvertSelection(display, clipboard_atom, utf8_atom, target_prop, win, 0);
    
    let start = std::time::Instant::now();
    let mut text = String::new();
    let mut success = false;
    
    while start.elapsed() < Duration::from_millis(500) {
      let mut event: XEvent = std::mem::zeroed();
      if XPending(display) > 0 {
        XNextEvent(display, &mut event);
        if event.r#type == 31 { // SelectionNotify
          let sel = event.selection;
          if sel.property != 0 {
            let mut actual_type = 0;
            let mut actual_format = 0;
            let mut nitems = 0;
            let mut bytes_after = 0;
            let mut prop_ptr: *mut u8 = std::ptr::null_mut();
            
            if XGetWindowProperty(
              display,
              win,
              sel.property,
              0,
              1024 * 1024,
              true, // delete property after read
              utf8_atom,
              &mut actual_type,
              &mut actual_format,
              &mut nitems,
              &mut bytes_after,
              &mut prop_ptr,
            ) == 0 && !prop_ptr.is_null() && nitems > 0 {
              let slice = std::slice::from_raw_parts(prop_ptr, nitems as usize);
              text = String::from_utf8_lossy(slice).into_owned();
              XFree(prop_ptr as *mut std::ffi::c_void);
              success = true;
            }
          }
          break;
        }
      } else {
        std::thread::sleep(Duration::from_millis(10));
      }
    }
    
    XCloseDisplay(display);
    if success {
      Ok(text)
    } else {
      Ok(CLIPBOARD_TEXT.lock().unwrap().clone().unwrap_or_default())
    }
  }
}

#[cfg(target_os = "linux")]
fn set_clipboard_linux(text: &str) -> Result<(), String> {
  ensure_clipboard_initialized();
  let win = match *CLIPBOARD_WINDOW.lock().unwrap() {
    Some(w) => w,
    None => return Err("Clipboard window uninitialized".into()),
  };
  
  {
    let mut text_lock = CLIPBOARD_TEXT.lock().unwrap();
    *text_lock = Some(text.to_string());
  }
  
  unsafe {
    let display = XOpenDisplay(std::ptr::null());
    if display.is_null() { return Err("Failed to open X11 display".into()); }
    let clipboard_atom = XInternAtom(display, "CLIPBOARD\0".as_ptr(), false);
    XSetSelectionOwner(display, clipboard_atom, win, 0);
    XCloseDisplay(display);
  }
  Ok(())
}

#[cfg(target_os = "linux")]
fn track_window_position_linux(app_handle: tauri::AppHandle, window_handle: usize) {
  unsafe {
    let display = XOpenDisplay(std::ptr::null());
    if display.is_null() { return; }

    let root = XDefaultRootWindow(display);
    const STRUCTURE_NOTIFY_MASK: i64 = 1 << 17;
    XSelectInput(display, window_handle as u64, STRUCTURE_NOTIFY_MASK);

    let mut attr = std::mem::zeroed();
    if XGetWindowAttributes(display, window_handle as u64, &mut attr) != 0 {
      let mut dest_x = 0;
      let mut dest_y = 0;
      let mut child = 0;
      if XTranslateCoordinates(display, window_handle as u64, root, 0, 0, &mut dest_x, &mut dest_y, &mut child) {
        app_handle.emit_all("native-window-bounds", BoundsPayload {
          handle: window_handle,
          x: dest_x,
          y: dest_y,
          width: attr.width,
          height: attr.height,
        }).ok();
      }
    }

    while IS_TRACKING.load(Ordering::SeqCst) {
      let mut event: XEvent = std::mem::zeroed();
      if XPending(display) > 0 {
        XNextEvent(display, &mut event);
        if event.r#type == 22 { // ConfigureNotify
          let mut dest_x = 0;
          let mut dest_y = 0;
          let mut child = 0;
          if XTranslateCoordinates(display, event.configure.window, root, 0, 0, &mut dest_x, &mut dest_y, &mut child) {
            app_handle.emit_all("native-window-bounds", BoundsPayload {
              handle: window_handle,
              x: dest_x,
              y: dest_y,
              width: event.configure.width,
              height: event.configure.height,
            }).ok();
          }
        } else if event.r#type == 17 { // DestroyNotify
          app_handle.emit_all("native-window-closed", window_handle).ok();
          break;
        }
      } else {
        std::thread::sleep(Duration::from_millis(100));
      }
    }

    XCloseDisplay(display);
  }
}

#[cfg(target_os = "linux")]
fn enumerate_x11_windows() -> Vec<WindowInfo> {
  let mut list = Vec::new();
  unsafe {
    let display = XOpenDisplay(std::ptr::null());
    if display.is_null() {
      return list;
    }
    let root = XDefaultRootWindow(display);
    let mut root_ret = 0;
    let mut parent_ret = 0;
    let mut children_ptr: *mut u64 = std::ptr::null_mut();
    let mut nchildren = 0;

    if XQueryTree(display, root, &mut root_ret, &mut parent_ret, &mut children_ptr, &mut nchildren) != 0 {
      if !children_ptr.is_null() && nchildren > 0 {
        let children = std::slice::from_raw_parts(children_ptr, nchildren as usize);
        for &win in children {
          let mut attr = std::mem::zeroed();
          if XGetWindowAttributes(display, win, &mut attr) != 0 {
            if attr.map_state == 2 && !attr.override_redirect {
              let mut name_ptr: *mut u8 = std::ptr::null_mut();
              if XFetchName(display, win, &mut name_ptr) != 0 && !name_ptr.is_null() {
                let name = std::ffi::CStr::from_ptr(name_ptr as *const i8).to_string_lossy().into_owned();
                XFree(name_ptr as *mut std::ffi::c_void);
                if !name.trim().is_empty() {
                  list.push(WindowInfo {
                    handle: win as usize,
                    title: name,
                  });
                }
              }
            }
          }
        }
        XFree(children_ptr as *mut std::ffi::c_void);
      }
    }
    XCloseDisplay(display);
  }
  list
}

#[cfg(target_os = "linux")]
fn capture_window_bmp(window_id: u32) -> Option<Vec<u8>> {
  capture_window_bmp_x11(window_id)
}

#[cfg(target_os = "linux")]
fn capture_window_bmp_x11(window_id: u32) -> Option<Vec<u8>> {
  unsafe {
    let display = XOpenDisplay(std::ptr::null());
    if display.is_null() { return None; }
    
    let mut attr = std::mem::zeroed();
    if XGetWindowAttributes(display, window_id as u64, &mut attr) == 0 {
      XCloseDisplay(display);
      return None;
    }
    
    let image_ptr = XGetImage(
      display,
      window_id as u64,
      0,
      0,
      attr.width as u32,
      attr.height as u32,
      !0,
      2, // ZPixmap
    );
    
    if image_ptr.is_null() {
      XCloseDisplay(display);
      return None;
    }
    
    let image = &*image_ptr;
    let len = (image.bytes_per_line * image.height) as usize;
    let slice = std::slice::from_raw_parts(image.data, len);
    
    let mut bgra = vec![0u8; (image.width * image.height * 4) as usize];
    for y in 0..image.height {
      let row_start = (y * image.bytes_per_line) as usize;
      for x in 0..image.width {
        let pixel_idx = row_start + (x * (image.bits_per_pixel / 8) as i32) as usize;
        let dest_idx = ((y * image.width + x) * 4) as usize;
        
        if image.bits_per_pixel == 32 || image.bits_per_pixel == 24 {
          bgra[dest_idx] = slice[pixel_idx]; // Blue
          bgra[dest_idx + 1] = slice[pixel_idx + 1]; // Green
          bgra[dest_idx + 2] = slice[pixel_idx + 2]; // Red
          bgra[dest_idx + 3] = 255; // Alpha
        }
      }
    }
    
    XDestroyImage(image_ptr);
    XCloseDisplay(display);
    
    let width = attr.width as u32;
    let height = attr.height as u32;
    
    if width > 1280 || height > 720 {
      let scale_x = width as f64 / 1280.0;
      let scale_y = height as f64 / 720.0;
      let scale = scale_x.max(scale_y);
      let new_width = (width as f64 / scale) as u32;
      let new_height = (height as f64 / scale) as u32;
      
      let mut downscaled = vec![0u8; (new_width * new_height * 4) as usize];
      for y in 0..new_height {
        let orig_y = ((y as f64 * scale) as u32).min(height - 1);
        for x in 0..new_width {
          let orig_x = ((x as f64 * scale) as u32).min(width - 1);
          let orig_idx = ((orig_y * width + orig_x) * 4) as usize;
          let dest_idx = ((y * new_width + x) * 4) as usize;
          downscaled[dest_idx..dest_idx + 4].copy_from_slice(&bgra[orig_idx..orig_idx + 4]);
        }
      }
      Some(encode_bmp(new_width, new_height, &downscaled))
    } else {
      Some(encode_bmp(width, height, &bgra))
    }
  }
}

#[cfg(target_os = "windows")]
fn capture_window_bmp(_window_id: u32) -> Option<Vec<u8>> {
  None
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn capture_window_bmp(_window_id: u32) -> Option<Vec<u8>> {
  None
}

#[tauri::command]
fn focus_native_window(handle: usize) {
  #[cfg(target_os = "windows")]
  unsafe {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    SetForegroundWindow(handle as windows_sys::Win32::Foundation::HWND);
  }

  #[cfg(target_os = "macos")]
  unsafe {
    let array = CGWindowListCopyWindowInfo(0, 0);
    if !array.is_null() {
      let count = CFArrayGetCount(array);
      for i in 0..count {
        let dict = CFArrayGetValueAtIndex(array, i);
        if !dict.is_null() {
          if let Some(win_id) = get_cf_number(dict, "kCGWindowNumber") {
            if win_id == handle as i64 {
              if let Some(pid) = get_cf_number(dict, "kCGWindowOwnerPID") {
                let cls_running_app = objc_getClass("NSRunningApplication\0".as_ptr());
                let sel_app_with_pid = sel_registerName("runningApplicationWithProcessIdentifier:\0".as_ptr());
                let msg_send_pid: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, i64) -> *mut std::ffi::c_void = std::mem::transmute(objc_msgSend as *const ());
                let app = msg_send_pid(cls_running_app, sel_app_with_pid, pid);
                if !app.is_null() {
                  let sel_activate = sel_registerName("activateWithOptions:\0".as_ptr());
                  let msg_send_act: unsafe extern "C" fn(*mut std::ffi::c_void, *mut std::ffi::c_void, u64) -> bool = std::mem::transmute(objc_msgSend as *const ());
                  msg_send_act(app, sel_activate, 1 << 1); // NSApplicationActivateIgnoringOtherApps = 1 << 1
                }
              }
              break;
            }
          }
        }
      }
      CFRelease(array);
    }
  }

  #[cfg(target_os = "linux")]
  unsafe {
    let display = XOpenDisplay(std::ptr::null());
    if !display.is_null() {
      XSetInputFocus(display, handle as u64, 1, 0); // 1 = RevertToParent, 0 = CurrentTime
      XCloseDisplay(display);
    }
  }
}

#[cfg(target_os = "windows")]
fn run_wasapi_loopback() {
  unsafe {
    use std::time::Duration;
    CoInitialize(std::ptr::null());
    
    let mut enumerator: *mut IMMDeviceEnumerator = std::ptr::null_mut();
    if CoCreateInstance(
      &CLSID_MMDeviceEnumerator,
      std::ptr::null_mut(),
      CLSCTX_ALL,
      &IID_IMMDeviceEnumerator,
      &mut enumerator as *mut *mut IMMDeviceEnumerator as *mut *mut std::ffi::c_void
    ) < 0 {
      return;
    }
    let enumerator = &*enumerator;

    let mut device: *mut IMMDevice = std::ptr::null_mut();
    if enumerator.GetDefaultAudioEndpoint(eRender, eConsole, &mut device) < 0 {
      enumerator.Release();
      return;
    }
    let device = &*device;

    let mut audio_client_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    if device.Activate(&IID_IAudioClient, CLSCTX_ALL, std::ptr::null_mut(), &mut audio_client_ptr) < 0 {
      device.Release();
      enumerator.Release();
      return;
    }
    let audio_client = &*(audio_client_ptr as *mut IAudioClient);

    let mut format_ptr: *mut WAVEFORMATEX = std::ptr::null_mut();
    if audio_client.GetMixFormat(&mut format_ptr) < 0 {
      audio_client.Release();
      device.Release();
      enumerator.Release();
      return;
    }
    let format = &*format_ptr;

    let hns_period: i64 = 10000000 / 100; // 100ms buffer
    if audio_client.Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK,
      hns_period,
      0,
      format_ptr,
      std::ptr::null()
    ) < 0 {
      windows_sys::Win32::System::Com::CoTaskMemFree(format_ptr as *mut std::ffi::c_void);
      audio_client.Release();
      device.Release();
      enumerator.Release();
      return;
    }

    let mut capture_client_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    if audio_client.GetService(&IID_IAudioCaptureClient, &mut capture_client_ptr) < 0 {
      windows_sys::Win32::System::Com::CoTaskMemFree(format_ptr as *mut std::ffi::c_void);
      audio_client.Release();
      device.Release();
      enumerator.Release();
      return;
    }
    let capture_client = &*(capture_client_ptr as *mut IAudioCaptureClient);

    if audio_client.Start() < 0 {
      capture_client.Release();
      windows_sys::Win32::System::Com::CoTaskMemFree(format_ptr as *mut std::ffi::c_void);
      audio_client.Release();
      device.Release();
      enumerator.Release();
      return;
    }

    let is_float = format.wFormatTag == 0xFFFE && {
      let ext = &*(format_ptr as *const WAVEFORMATEXTENSIBLE);
      ext.SubFormat == windows_sys::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71)
    };

    while IS_CAPTURING_AUDIO.load(std::sync::atomic::Ordering::SeqCst) {
      let mut packet_len: u32 = 0;
      if capture_client.GetNextPacketSize(&mut packet_len) >= 0 && packet_len > 0 {
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut num_frames: u32 = 0;
        let mut flags: u32 = 0;
        let mut dev_pos: u64 = 0;
        let mut qpc_pos: u64 = 0;
        
        if capture_client.GetBuffer(&mut data, &mut num_frames, &mut flags, &mut dev_pos, &mut qpc_pos) >= 0 {
          let num_channels = format.nChannels as usize;
          let mut pcm_out = Vec::with_capacity(num_frames as usize * num_channels * 2);
          
          if is_float {
            let float_slice = std::slice::from_raw_parts(data as *const f32, num_frames as usize * num_channels);
            for &f in float_slice {
              let sample = (f.clamp(-1.0, 1.0) * 32767.0) as i16;
              pcm_out.extend_from_slice(&sample.to_le_bytes());
            }
          } else if format.wBitsPerSample == 16 {
            let pcm_slice = std::slice::from_raw_parts(data, num_frames as usize * num_channels * 2);
            pcm_out.extend_from_slice(pcm_slice);
          }

          if !pcm_out.is_empty() {
            if let Ok(mut buffer) = AUDIO_BUFFER.lock() {
              buffer.extend_from_slice(&pcm_out);
              if buffer.len() > 1024 * 1024 {
                buffer.drain(0..buffer.len() - 1024 * 1024);
              }
            }
          }

          capture_client.ReleaseBuffer(num_frames);
        }
      }
      std::thread::sleep(Duration::from_millis(10));
    }

    audio_client.Stop();
    capture_client.Release();
    windows_sys::Win32::System::Com::CoTaskMemFree(format_ptr as *mut std::ffi::c_void);
    audio_client.Release();
    device.Release();
    enumerator.Release();
  }
}

#[tauri::command]
fn stop_uinput_session() {
  #[cfg(target_os = "linux")]
  {
    let mut dev_lock = UINPUT_DEVICE.lock().unwrap();
    *dev_lock = None;
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  #[cfg(target_os = "windows")]
  fn test_win32_clipboard_raw() {
    let test_str = "Hello from Win32 raw test!";
    let set_res = set_clipboard_text(test_str);
    assert!(set_res.is_ok(), "Failed to set clipboard: {:?}", set_res);

    let get_res = get_clipboard_text();
    assert!(get_res.is_ok(), "Failed to get clipboard: {:?}", get_res);
    assert_eq!(get_res.unwrap(), test_str);
  }
}
