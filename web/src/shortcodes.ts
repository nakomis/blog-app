const shortcodes: Record<string, string> = {
  donate: `<hr />
<p>If you find this blog useful, please consider a donation.</p>
<form action="https://www.paypal.com/donate" method="post" target="_top">
<input type="hidden" name="hosted_button_id" value="Q3BESC73EWVNN" />
<input type="image" src="https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif" border="0" name="submit" title="PayPal - The safer, easier way to pay online!" alt="Donate with PayPal button" />
<img alt="" border="0" src="https://www.paypal.com/en_GB/i/scr/pixel.gif" width="1" height="1" />
</form>`,
};

export function applyShortcodes(markdown: string): string {
  return markdown.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    return shortcodes[name] ?? match;
  });
}
