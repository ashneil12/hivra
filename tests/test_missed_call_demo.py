import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "missed-call-demo.html"


class MissedCallDemoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = DEMO.read_text(encoding="utf-8")

    def test_is_one_offline_self_contained_html_document(self):
        self.assertIn("<!doctype html>", self.html.lower())
        self.assertIn("<style>", self.html)
        self.assertIn("<script>", self.html)
        self.assertNotRegex(self.html, r"(?:src|href)=[\"']https?://")

    def test_keeps_business_and_postcode_in_editable_config(self):
        self.assertRegex(self.html, r"businessName:\s*[\"']Dave's Plumbing[\"']")
        self.assertRegex(self.html, r"postcode:\s*[\"']BS7[\"']")

    def test_contains_all_required_story_copy(self):
        required = (
            "Never lose another plumbing or heating job to voicemail.",
            "See how a missed call about a broken boiler becomes a qualified, booked visit while you're still on the tools.",
            "You're in the middle of a plumbing job. You can't pick up.",
            "The customer gets a reply in seconds.",
            "They tell you what's wrong with the boiler.",
            "It checks how urgent the boiler fault is, then qualifies the visit.",
            "It pencils the boiler visit into your diary.",
            "A qualified boiler job lands on your phone.",
            "It answers. It checks the fault. It books the boiler visit. All while you're still on the tools.",
            "Set up in a day. Keep the number your customers already know.",
            "What plumbing or heating problem can we help with, and what's the postcode?",
            "Sorry to hear that. No hot water can be urgent. Do you need Dave to call as soon as he's free, or can it wait until tomorrow? Is the boiler making any unusual noise or losing pressure?",
            "It can wait until tomorrow. Bit of a banging noise. Morning's better.",
            "Thanks. I've pencilled in a boiler visit for tomorrow morning. Dave will call to confirm shortly. If it becomes urgent, reply here and we'll get him to call as soon as possible.",
            "New boiler visit",
            "Plumbing and heating",
            "Confirm visit",
            "Tomorrow AM",
            "Radiator leak",
            "Tap replacement",
            "Bathroom quote",
            "Awaiting confirmation",
        )
        for line in required:
            with self.subTest(line=line):
                self.assertIn(line, self.html)

    def test_removes_generic_trade_language_from_the_visible_story(self):
        self.assertNotIn("off the ladder", self.html)
        self.assertNotIn("It replies in seconds.", self.html)
        self.assertNotIn("They tell it the job.", self.html)
        self.assertNotIn("Works with your number.", self.html)

    def test_autoplays_with_keyboard_override_and_no_presenter_chrome(self):
        self.assertRegex(self.html, r'<section[^>]+id="intro"[^>]+role="button"')
        self.assertRegex(self.html, r'intro\.addEventListener\(["\']click["\']')
        self.assertIn("const TIMINGS", self.html)
        self.assertIn("window.setTimeout", self.html)
        self.assertIn("scheduleNextStep", self.html)
        self.assertIn('event.code === "ArrowRight"', self.html)
        self.assertIn('event.code === "ArrowLeft"', self.html)
        self.assertNotRegex(self.html, r'id="advance"')
        self.assertNotIn("progress-wrap", self.html)
        self.assertNotIn("key-hint", self.html)
        self.assertIn("const STEPS", self.html)

    def test_typing_indicator_waits_before_each_message_is_revealed(self):
        self.assertIn("typingDelay", self.html)
        self.assertIn("revealMessage", self.html)
        self.assertRegex(self.html, r'classList\.add\(["\']play["\']\)')
        self.assertRegex(self.html, r'classList\.remove\(["\']play["\']\)')

    def test_bookings_phone_is_populated_before_the_new_lead_arrives(self):
        self.assertGreaterEqual(len(re.findall(r'class="booking-row existing"', self.html)), 3)
        self.assertRegex(self.html, r'id="lead-alert"[^>]+class="booking-row lead-alert"')

    def test_has_intro_seven_named_beats_and_a_replay_control(self):
        self.assertIn('data-beat="intro"', self.html)
        for beat in (
            "missed-call",
            "auto-text",
            "customer-reply",
            "qualification",
            "booking",
            "job-booking",
            "end-card",
        ):
            with self.subTest(beat=beat):
                self.assertIn(f'data-beat="{beat}"', self.html)
        self.assertRegex(self.html, r'<button[^>]+id="replay"')
        self.assertRegex(self.html, r'replay\.addEventListener\(["\']click["\']')

    def test_uses_clearweb_branding_and_real_call_control_icons(self):
        self.assertIn("ClearWeb", self.html)
        self.assertIn(
            "Never lose another plumbing or heating job to voicemail.", self.html
        )
        self.assertRegex(self.html, r'class="logo wordmark"')
        self.assertNotIn("Start the demo", self.html)
        self.assertNotIn("Presenter controlled. Move at your own pace.", self.html)
        self.assertNotIn("Missed-call text-back for trades", self.html)
        self.assertRegex(self.html, r'aria-label="Decline call"')
        self.assertRegex(self.html, r'aria-label="Answer call"')
        self.assertGreaterEqual(len(re.findall(r"<svg\b", self.html)), 2)

    def test_supports_fullscreen_recording_and_reduced_motion(self):
        self.assertIn("aspect-ratio: 16 / 9", self.html)
        self.assertIn("@media (prefers-reduced-motion: reduce)", self.html)
        self.assertIn("aria-live=\"polite\"", self.html)


if __name__ == "__main__":
    unittest.main()
