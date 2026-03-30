import { useState, useRef, FormEvent, KeyboardEvent } from 'react';

interface SearchResult {
  id: string;
  postSlug: string;
  postTitle: string;
  postDate: string;
  postUrl: string;
  heading: string;
  excerpt: string;
}

interface SearchResponse {
  results: SearchResult[];
}

export default function BlogSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    setResults(null);

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });

      if (!response.ok) {
        throw new Error(`Search failed (${response.status})`);
      }

      const data: SearchResponse = await response.json();
      setResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    runSearch(query);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setQuery('');
      setResults(null);
      setError(null);
    }
  };

  const clearSearch = () => {
    setQuery('');
    setResults(null);
    setError(null);
    inputRef.current?.focus();
  };

  return (
    <div className="blog-search">
      <form className="search-form" onSubmit={handleSubmit} role="search">
        <div className="search-input-wrapper">
          <input
            ref={inputRef}
            type="search"
            className="search-input"
            placeholder="Search posts…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Search blog posts"
            autoComplete="off"
          />
          <button
            type="submit"
            className="search-button"
            disabled={loading || !query.trim()}
            aria-label="Search"
          >
            {loading ? (
              <span className="search-spinner" aria-hidden="true" />
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            )}
          </button>
        </div>
        <p className="search-hint">Powered by semantic search — try a concept such as &ldquo;voice control&rdquo; or &ldquo;SSL certificates&rdquo;, not just keywords</p>
      </form>

      {error && (
        <p className="search-error">{error}</p>
      )}

      {results !== null && (
        <div className="search-results">
          <div className="search-results-header">
            <h3>
              {results.length === 0
                ? 'No results found'
                : `${results.length} result${results.length === 1 ? '' : 's'}`}
            </h3>
            <button className="search-clear" onClick={clearSearch}>
              ← Back to all posts
            </button>
          </div>

          {results.length > 0 && (
            <div className="search-results-list">
              {results.map(result => (
                <article key={result.id} className="search-result-item post-preview">
                  <h3>
                    <a href={`/${result.postSlug}`} className="post-card-link">
                      {result.postTitle}
                    </a>
                  </h3>
                  {result.heading && (
                    <p className="search-result-heading">{result.heading}</p>
                  )}
                  <div className="post-meta">
                    <time dateTime={result.postDate}>
                      {new Date(result.postDate).toLocaleDateString('en-GB', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                      })}
                    </time>
                  </div>
                  <p className="excerpt">{result.excerpt}</p>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
