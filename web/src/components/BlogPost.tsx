import { BlogPost as BlogPostType } from '../types';

interface BlogPostProps {
  post: BlogPostType;
}

export default function BlogPost({ post }: BlogPostProps) {
  const { frontmatter, html } = post;

  return (
    <article className="blog-post">
      <header className="post-header">
        <h1>{frontmatter.title}</h1>
        <div className="post-meta">
          <time dateTime={frontmatter.date}>
            {new Date(frontmatter.date).toLocaleDateString('en-GB', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </time>
          <span className="author">by {frontmatter.author}</span>
        </div>
        <div className="post-tags">
          {frontmatter.tags.map(tag => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>
      </header>

      <div
        className="post-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <footer className="post-footer">
        <p>
          <strong>Canonical URL:</strong>{' '}
          <a href={frontmatter.canonical}>{frontmatter.canonical}</a>
        </p>
      </footer>
    </article>
  );
}