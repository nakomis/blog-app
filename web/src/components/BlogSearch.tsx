import { useState, useRef, FormEvent, KeyboardEvent } from 'react';

type SearchMode = 'hybrid' | 'semantic' | 'fulltext';

const MODES: { value: SearchMode; label: string; description: string }[] = [
  {
    value: 'hybrid',
    label: 'Hybrid',
    description: 'Best of both — combines semantic understanding with exact keyword matching. A good default for most searches.',
  },
  {
    value: 'semantic',
    label: 'Semantic',
    description: 'Understands concepts and meaning rather than exact words. Describe what you\'re looking for — e.g. "voice control" rather than a specific function name.',
  },
  {
    value: 'fulltext',
    label: 'Full-Text',
    description: 'Exact keyword matching. Ideal for specific terms, error messages, or quoted phrases.',
  },
];

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
  const [mode, setMode] = useState<SearchMode>('hybrid');
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
        body: JSON.stringify({ query: trimmed, mode }),
      });

      if (response.status === 429) {
        throw new Error('Search is temporarily disabled due to global usage quotas');
      }

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
        <div className="search-mode-row">
          <div className="search-mode-buttons" role="group" aria-label="Search mode">
            {MODES.map(m => (
              <button
                key={m.value}
                type="button"
                className={`search-mode-btn${mode === m.value ? ' active' : ''}`}
                onClick={() => setMode(m.value)}
                aria-pressed={mode === m.value}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="search-hint">
            {MODES.find(m => m.value === mode)!.description}
          </p>
        </div>
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
                  {result.heading && result.heading !== result.postTitle && (
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
