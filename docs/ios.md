# iPhone tips

## "Can my iPhone start a call by itself when a message arrives?"

**Not reliably, and that's the reason SOS2me exists.** iOS doesn't let apps or Shortcuts
silently dial a number when a message arrives:

- A Shortcuts _Message_ automation can run when a message arrives, but a **Call** action needs
  the phone to be unlocked and a tap, so it fails exactly when you're busy, asleep or driving.
- Apps can't read iMessage/SMS content at all.

SOS2me turns the problem around. **A real phone call comes to you** from Twilio, reads the
message aloud, and repeats until you press 1. What's left is making sure your iPhone lets that
call ring through.

## Parent's iPhone: make SOS2me's calls always ring

1. **Save the Twilio number as a contact**, e.g. "SOS2me – Alex", with a distinctive photo.
2. Turn on **Emergency Bypass** for that contact: open the contact → **Edit** → **Ringtone** → **Emergency Bypass: on**.
   It then rings even when the phone is on silent or in Do Not Disturb / Sleep Focus.
3. Add it to **Favorites** (Phone app). Then under **Settings → Focus → Do Not Disturb → People**,
   allow calls from Favorites, and keep **Allow Repeated Calls** on. If you decline an SOS2me call,
   it rings you again straight away, and that second call gets through Focus.
4. Also turn on Emergency Bypass for **text messages** from that contact (Edit → Text Tone → Emergency Bypass),
   if you enabled SMS.
5. **Silence Unknown Callers** (Settings → Phone) is fine to keep on, as long as the number is saved as a contact.

Test it: switch the phone to silent + Sleep Focus, then press **Test call** in Settings → Family.

## Child's iPhone

### Kid page on the Home Screen

Open the kid page (e.g. `https://sos.example.com/`) in Safari → **Share** → **Add to Home Screen**. It then opens like an app.
The PIN is asked once, then remembered.

### One-tap SOS with Shortcuts, Siri, Back Tap or the Action button

The kid page API accepts the PIN directly, so an iPhone Shortcut can send an SOS without opening Safari:

1. Open **Shortcuts** → **+** → **Add Action** → **Get Contents of URL**.
2. URL: `https://sos.example.com/api/kid/home/send` (kid page at the main address), or
   `https://<address>/api/kid/<kid-link-token>/send` for the secret-link version.
3. Tap **Show More**:
   - **Method:** POST
   - **Request Body:** JSON
   - **Fields:**
     - `sos` (Boolean) = true
     - `text` (Text) = "SOS from Shortcut"
     - `pin` (Text) = your kid PIN
4. Name it **"SOS"**. Your child can now:
   - say **"Hey Siri, SOS"**,
   - tap it from the Home Screen,
   - set **Settings → Accessibility → Touch → Back Tap → Double Tap → SOS**, or
   - assign it to the **Action button** (iPhone 15 Pro and later).

Optional: add a **Get Current Location** action first and put the location in `text`, so parents
get "SOS — near Orchard Rd" on the call.

### Also set up Apple's built-in Emergency SOS

Apple's **Emergency SOS** is separate from SOS2me, and the two work well together:

- Holding the side button and a volume button calls emergency services (999/995 in Singapore).
- It then texts your **Emergency Contacts** with the location.

To set it up, open the **Health** app → **Medical ID** → **Emergency Contacts** and add both parents.
