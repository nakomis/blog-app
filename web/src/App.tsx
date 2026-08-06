import React from 'react';
import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom';
import { getBlogPostBySlug, getBlogPosts, getBlogPostList } from './utils/contentProcessor';
import BlogHeader from './components/BlogHeader';
import BlogFooter from './components/BlogFooter';
import BlogHome from './components/BlogHome';
import BlogPost from './components/BlogPost';
import './App.css';

// The post list is derived from a compile-time constant, so it is itself
// constant. Computing it once at module scope makes that obvious and keeps it
// out of every render.
const POST_LIST = getBlogPostList(getBlogPosts());

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="container">
    <BlogHeader />
    <main className="main-content">{children}</main>
    <BlogFooter />
  </div>
);

// One component for every way of missing, so the markup is identical whichever
// route produced it. dist/404.html is prerendered from this and then served for
// any unmatched path — including multi-segment ones that `/:slug` never
// matches — so if the two disagreed, hydration would blank the page.
const NotFoundPage: React.FC = () => (
  <Shell>
    <div className="error">
      <h1>Page not found</h1>
      <p>That page doesn&rsquo;t exist. <a href="/">Back to the blog</a>.</p>
    </div>
  </Shell>
);

const PostPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  // Synchronous: the post either exists in the bundle or it does not. There is
  // no loading state to render because there is nothing to wait for.
  const post = slug ? getBlogPostBySlug(slug) : null;

  if (!post) return <NotFoundPage />;

  return <Shell><BlogPost post={post} /></Shell>;
};

const HomePage: React.FC = () => <Shell><BlogHome posts={POST_LIST} /></Shell>;

// Routes without a router, so the same tree can be driven by BrowserRouter in
// the browser and StaticRouter during prerendering (see entry-server.tsx).
export const AppRoutes: React.FC = () => (
  <Routes>
    <Route path="/" element={<HomePage />} />
    <Route path="/:slug" element={<PostPage />} />
    <Route path="*" element={<NotFoundPage />} />
  </Routes>
);

const App: React.FC = () => (
  <Router>
    <AppRoutes />
  </Router>
);

export default App;
