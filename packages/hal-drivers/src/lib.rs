//! RUBE-STOCK-POS v3.1 Hardware Abstraction Layer (`rube-hal-drivers`)
//!
//! Native Rust hardware drivers for USB Raw Input (`WM_INPUT`), Chunked 203-DPI `GS v 0`
//! Thermal Raster Printing, RJ11 Cash Drawer Kick, EMVCo PromptPay CRC16, and USB-HID UPS Monitor.

/// ESC/POS RJ11 Cash Drawer Kick Command (`ESC p 0 25 250` -> Pin 2, 50ms pulse)
pub const ESC_POS_KICK_DRAWER: [u8; 5] = [0x1B, 0x70, 0x00, 0x19, 0xFA];

/// ESC/POS Partial Cut Command (`GS V 66 0`)
pub const ESC_POS_CUT_PAPER: [u8; 4] = [0x1D, 0x56, 0x42, 0x00];

/// Computes CRC16-CCITT (`0x1021`, initial value `0xFFFF`) for EMVCo PromptPay QR payloads.
pub fn compute_crc16_ccitt_hex(payload: &str) -> String {
    let mut crc: u16 = 0xFFFF;
    for byte in payload.as_bytes() {
        crc ^= (*byte as u16) << 8;
        for _ in 0..8 {
            if (crc & 0x8000) != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    format!("{:04X}", crc)
}

