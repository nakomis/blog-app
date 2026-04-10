import { BlogPost } from './types';

type Frontmatter = BlogPost['frontmatter'];

function renderDonate(slug?: string): string {
  const customField = slug ? `\n<input type="hidden" name="custom" value="${slug}" />` : '';
  return `<hr />
<p>If you find this blog useful, please consider a donation.</p>
<form action="https://www.paypal.com/donate" method="post" target="_top">
<input type="hidden" name="hosted_button_id" value="Q3BESC73EWVNN" />${customField}
<input type="image" src="https://www.paypalobjects.com/en_GB/i/btn/btn_donate_SM.gif" border="0" name="submit" title="PayPal - The safer, easier way to pay online!" alt="Donate with PayPal button" />
<img alt="" border="0" src="https://www.paypal.com/en_GB/i/scr/pixel.gif" width="1" height="1" />
</form>`;
}

function renderRepos(repos: NonNullable<Frontmatter['repos']>): string {
  const items = repos
    .map(r => `<li><a href="${r.url}" target="_blank" rel="noopener noreferrer">${r.name}</a></li>`)
    .join('');
  return `<div class="post-repos"><strong>Source code</strong><ul>${items}</ul></div>`;
}

export function applyShortcodes(markdown: string, frontmatter?: Frontmatter, slug?: string): string {
  return markdown.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (name === 'repos') {
      return frontmatter?.repos?.length ? renderRepos(frontmatter.repos) : '';
    }
    if (name === 'donate') {
      return renderDonate(slug);
    }
    return match;
  });
}
