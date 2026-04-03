import { useEffect, useRef, useState } from 'react';
import { BlogPost as BlogPostType } from '../types';

interface BlogPostProps {
  post: BlogPostType;
}

function setMeta(name: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

function setOgMeta(property: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute('property', property);
    document.head.appendChild(el);
  }
  el.content = content;
}

function setCanonical(url: string) {
  let el = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.rel = 'canonical';
    document.head.appendChild(el);
  }
  el.href = url;
}

export default function BlogPost({ post }: BlogPostProps) {
  const { frontmatter, html } = post;
  const contentRef = useRef<HTMLDivElement>(null);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = `${frontmatter.title} | Martin Harris`;
    setMeta('description', frontmatter.excerpt);
    if (frontmatter.canonical) {
      setCanonical(frontmatter.canonical);
      setOgMeta('og:url', frontmatter.canonical);
    }
    setOgMeta('og:title', frontmatter.title);
    setOgMeta('og:description', frontmatter.excerpt);
    setOgMeta('og:type', 'article');
    return () => {
      document.title = prev;
    };
  }, [frontmatter]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const imgs = el.querySelectorAll<HTMLImageElement>('img');
    const handlers: Array<() => void> = [];
    imgs.forEach(img => {
      const handler = () => setLightboxSrc(img.src);
      img.addEventListener('click', handler);
      handlers.push(() => img.removeEventListener('click', handler));
    });
    return () => handlers.forEach(cleanup => cleanup());
  }, [html]);

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
        ref={contentRef}
        className="post-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <footer className="post-footer">
        <p>
          <strong>Canonical URL:</strong>{' '}
          <a href={frontmatter.canonical}>{frontmatter.canonical}</a>
        </p>
      </footer>

      {lightboxSrc && (
        <div className="lightbox" onClick={() => setLightboxSrc(null)}>
          <img src={lightboxSrc} alt="" />
        </div>
      )}
    </article>
  );
}
