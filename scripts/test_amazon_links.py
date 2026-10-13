"""Tests for amazon_links (BAPP-16). Run: python3 -m unittest discover -s scripts -p 'test_*.py'"""
import unittest

from amazon_links import ShortLinkError, extract_asin, untag_markdown, untag_url


class UntagUrlTest(unittest.TestCase):
    def test_uk_product_becomes_plain_canonical(self):
        self.assertEqual(
            untag_url("https://www.amazon.co.uk/diymore/dp/B0F4D8ZY6L/ref=sr_1_3?crid=X&tag=nakomis-esp32-21"),
            "https://www.amazon.co.uk/dp/B0F4D8ZY6L",
        )
        self.assertEqual(
            untag_url("https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21"),
            "https://www.amazon.co.uk/dp/B0F4D8ZY6L",
        )
        self.assertEqual(
            untag_url("http://amazon.co.uk/gp/product/b0crk47hxm"),
            "https://www.amazon.co.uk/dp/B0CRK47HXM",
        )

    def test_other_amazon_pages_lose_only_the_tag(self):
        self.assertEqual(
            untag_url("https://www.amazon.co.uk/s?k=esp32&tag=nakomis-21"),
            "https://www.amazon.co.uk/s?k=esp32",
        )
        self.assertEqual(
            untag_url("https://www.amazon.com/dp/B0F4D8ZY6L?tag=someone-20&th=1"),
            "https://www.amazon.com/dp/B0F4D8ZY6L?th=1",
        )

    def test_non_amazon_untouched(self):
        for url in [
            "https://github.com/nakomis/claude-chats?tag=v1",
            "https://notamazon.co.uk/dp/B0F4D8ZY6L?tag=x",
        ]:
            self.assertEqual(untag_url(url), url)

    def test_short_links_refused(self):
        for url in ["https://link.amazon/B00Ka0e27", "https://amzn.to/3abc"]:
            with self.assertRaises(ShortLinkError):
                untag_url(url)

    def test_extract_asin(self):
        self.assertEqual(extract_asin("/x/dp/B0F4D8ZY6L/ref=y"), "B0F4D8ZY6L")
        self.assertIsNone(extract_asin("/s"))


class UntagMarkdownTest(unittest.TestCase):
    def test_markdown_html_and_bare_links(self):
        md = (
            "An [ESP32-S3 CAM](https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-esp32-21) board.\n"
            '<a href="https://www.amazon.co.uk/gp/product/B0CRK47HXM?tag=nakomis-21">three</a>\n'
            "Bare: https://www.amazon.co.uk/dp/B0CRK47HXM?tag=nakomis-21.\n"
            "[code](https://github.com/nakomis/claude-chats)"
        )
        out = untag_markdown(md)
        self.assertNotIn("tag=", out)
        self.assertIn("[ESP32-S3 CAM](https://www.amazon.co.uk/dp/B0F4D8ZY6L) board.", out)
        self.assertIn('href="https://www.amazon.co.uk/dp/B0CRK47HXM">three', out)
        self.assertIn("Bare: https://www.amazon.co.uk/dp/B0CRK47HXM.\n", out)
        self.assertIn("[code](https://github.com/nakomis/claude-chats)", out)

    def test_code_fences_left_alone(self):
        md = "```bash\ncurl 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21'\n```\n"
        self.assertEqual(untag_markdown(md), md)

    def test_short_link_in_prose_refused(self):
        with self.assertRaises(ShortLinkError):
            untag_markdown("[board](https://link.amazon/B00Ka0e27)")


if __name__ == "__main__":
    unittest.main()
