# Troubleshooting & Manual Real-Account Verification (`TROUBLESHOOTING.md`)

## 1. Common Issues & Resolutions

### Issue: Startup fails with `Startup Configuration Validation Failed`
- **Cause**: `TELEGRAM_BOT_TOKEN` or `TELEGRAM_ADMIN_ID` is missing or invalid in `.env`.
- **Fix**: Ensure `TELEGRAM_ADMIN_ID` contains only digits (your numeric Telegram ID, not `@username`) and `TELEGRAM_BOT_TOKEN` is valid.

### Issue: Telegram Bot replies `⛔ غير مصرح لك باستخدام هذا البوت`
- **Cause**: Your Telegram account's numeric ID does not match `TELEGRAM_ADMIN_ID`.
- **Fix**: Check `audit_logs` or server logs for `candidateUserId` and update `TELEGRAM_ADMIN_ID` in `.env`, then restart the service.

### Issue: Pairing Code expires or fails to link
- **Cause**: Phone number was entered without country code, or the pairing code was not entered in WhatsApp within ~60 seconds, or WhatsApp rate-limited pairing requests for that number.
- **Fix**:
  1. Ensure the phone number is entered in full international format (`+9665XXXXXXXX`).
  2. Open WhatsApp on your phone **before** requesting the code: **Settings / Linked Devices -> Link a Device -> Link with phone number instead**.
  3. Wait at least 2 minutes before requesting a new pairing code for the same phone number.

### Issue: Session transitions to `LOGGED_OUT`
- **Cause**: The user unlinked the device from their phone's WhatsApp app, or WhatsApp invalidated the multi-device session.
- **Fix**: The system automatically purges the invalidated local credentials in `WHATSAPP_AUTH_DIR/<sessionId>`. Open the bot, go to **📋 إدارة الجلسات**, select the session, and click **📲 إعادة الربط برقم هاتف**.

---

## 2. Manual Integration Checklist with a Real WhatsApp Account (`athanasia-baileys`)

Automated tests (`npm test`) use `MockWhatsAppSessionDriver` (plus direct unit tests for `athanasia-baileys` JID, `Browsers`, `DisconnectReason`, and `useMultiFileAuthState` helpers) so they never require live accounts or send real messages. To perform manual verification with a real WhatsApp account over live WhatsApp WebSockets:

1. Configure `.env` with a real `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_ID`.
2. Start the standalone bot daemon: `npm run bot:start`.
3. Open your bot in Telegram and send `/start`.
4. Click **📲 ربط حساب واتساب** and send your secondary test WhatsApp number in international format (`+<country><number>`, e.g. `+966501234567`), or with an optional custom 8-character alphanumeric pairing code supported by `athanasia-baileys` (`+966501234567 MYCODE12`).
5. Enter the 8-character pairing code displayed by the bot into WhatsApp on your phone (**Linked Devices -> Link with phone number**).
6. Verify that after the post-pairing `DisconnectReason.restartRequired` (`515`) handshake completes, the session status transitions to **🟢 متصل** (`CONNECTED`) in **📋 إدارة الجلسات**.
7. Restart the process (`Ctrl+C` then `npm run bot:start`) and confirm the session automatically restores to `CONNECTED` without re-pairing.
8. Test **✉️ إرسال رسالة نصية** and **📎 إرسال وسائط أو ملف** to another test number you own and verify delivery and task completion (`✅ مكتملة بنجاح`).
9. Test **👥 إدارة المجموعات** and **🔗 الانضمام إلى مجموعة** on a test group where your linked account is a member/admin.
