import { BlogPostListItem } from '../types';

interface BlogHomeProps {
  posts: BlogPostListItem[];
}

export default function BlogHome({ posts }: BlogHomeProps) {
  return (
    <div className="blog-home">
      <section className="posts">
        <h2>Latest Articles</h2>
        {posts.length === 0 ? (
          <p>No posts yet. Coming soon!</p>
        ) : (
          <div className="posts-list">
            {posts.map(post => (
              <article key={post.slug} className="post-preview">
                <h3>
                  <a href={`/${post.slug}`} className="post-card-link">{post.title}</a>
                </h3>
                <div className="post-meta">
                  <time dateTime={post.date}>
                    {new Date(post.date).toLocaleDateString('en-GB', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </time>
                </div>
                <p className="excerpt">{post.excerpt}</p>
                <div className="post-tags">
                  {post.tags.map(tag => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}