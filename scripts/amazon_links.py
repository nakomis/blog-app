"""Amazon Associates links in the Substack copy of a post (BAPP-16).

The Associates Operating Agreement does not allow Special Links (tagged
affiliate links) in emails, and every new Substack post is emailed to
subscribers. So the copy of a post that goes to Substack gets plain Amazon
links: same product, no tag. The blog itself keeps the tagged links; its build
(web/src/utils/amazonLinks.ts) is where they are added and checked.

SiteStripe short links (link.amazon/..., amzn.to/...) carry the tag inside the
redirect, so they cannot be untagged here. The blog build already refuses to
publish a post that still has one (they are resolved at authoring time by
blog-content's scripts/resolve-amazon-links.py), so meeting one here means
something went wrong: fail rather than email a tagged link.

Stdlib only, so it can be unit-tested without the Substack venv:

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SHORT_LINK_HOSTS = {"link.amazon", "amzn.to", "amzn.eu", "a.co"}

# Same path shapes as amazonLinks.ts.
ASIN_PATH_RES = [
    re.compile(r"/dp/([A-Z0-9]{10})(?:[/?#]|$)", re.I),
    re.compile(r"/gp/product/([A-Z0-9]{10})(?:[/?#]|$)", re.I),
    re.compile(r"/gp/aw/d/([A-Z0-9]{10})(?:[/?#]|$)", re.I),
    re.compile(r"/exec/obidos/ASIN/([A-Z0-9]{10})(?:[/?#]|$)", re.I),
    re.compile(r"/o/ASIN/([A-Z0-9]{10})(?:[/?#]|$)", re.I),
]

# A URL in Markdown or raw HTML: stops at whitespace, a closing bracket or
# parenthesis, a quote or an angle bracket.
URL_RE = re.compile(r"""https?://[^\s()\[\]<>"']+""")

FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")


class ShortLinkError(ValueError):
    """A short link that cannot be untagged."""


def _is_amazon_host(host: str) -> bool:
    return re.search(r"(^|\.)amazon\.[a-z.]+$", host) is not None


def extract_asin(path: str) -> str | None:
    for regex in ASIN_PATH_RES:
        m = regex.search(path)
        if m:
            return m.group(1).upper()
    return None


def untag_url(url: str) -> str:
    """The URL without an Associates tag; unchanged if it is not an Amazon link.

    UK product pages become the canonical https://www.amazon.co.uk/dp/<ASIN>,
    dropping the ref= path and tracking parameters along with the tag. Any
    other Amazon page just loses its `tag` parameter.
    """
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if host in SHORT_LINK_HOSTS:
        raise ShortLinkError(
            f"{url} is an Amazon short link with the affiliate tag inside it, "
            "so it cannot go in an email; resolve it with "
            "blog-content/scripts/resolve-amazon-links.py"
        )
    if not _is_amazon_host(host):
        return url
    if host == "amazon.co.uk" or host.endswith(".amazon.co.uk"):
        asin = extract_asin(parts.path)
        if asin:
            return f"https://www.amazon.co.uk/dp/{asin}"
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "tag"]
    return urlunsplit(parts._replace(query=urlencode(query)))


def _untag_match(m: re.Match) -> str:
    # Sentence punctuation after a bare URL is not part of it (GFM agrees).
    url = m.group(0)
    trailing = ""
    while url and url[-1] in ".,;:!?":
        trailing = url[-1] + trailing
        url = url[:-1]
    return untag_url(url) + trailing


def untag_markdown(md: str) -> str:
    """Untag every Amazon link in a post's Markdown, leaving code fences alone."""
    out = []
    fence = None
    for line in md.split("\n"):
        m = FENCE_RE.match(line)
        if m:
            marker = m.group(1)
            if fence is None:
                fence = marker[0] * 3
            elif line.strip().startswith(fence):
                fence = None
            out.append(line)
            continue
        if fence is None:
            line = URL_RE.sub(_untag_match, line)
        out.append(line)
    return "\n".join(out)
