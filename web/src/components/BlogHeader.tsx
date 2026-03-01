export default function BlogHeader() {
  return (
    <header className="header">
      <div className="header-content">
        <a href="/">
          <img src="/logo-shaded-transparent.png" alt="nakom.is" className="logo" />
        </a>
        <div className="hero-text">
          <h1 className="hero-name">Martin Harris</h1>
          <p className="hero-tagline">
            <em>"Ceci n'est pas une API Gateway"</em>
            {' — '}
            <a href="https://en.wikipedia.org/wiki/The_Treachery_of_Images" target="_blank" rel="noopener">
              René Magritte
            </a>
            {' (paraphrased)'}
          </p>
          <p className="hero-description">Making cloud abstractions tangible through physical hardware.</p>
        </div>
        <div className="header-spacer" aria-hidden="true" />
      </div>
    </header>
  );
}
