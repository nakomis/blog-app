import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom';
import { BlogPost as BlogPostType, BlogPostListItem } from './types';
import { getBlogPostBySlug, getBlogPosts, getBlogPostList } from './utils/contentProcessor';
import BlogHeader from './components/BlogHeader';
import BlogFooter from './components/BlogFooter';
import BlogHome from './components/BlogHome';
import BlogPost from './components/BlogPost';
import './App.css';

const PostPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [post, setPost] = useState<BlogPostType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadPost = async () => {
      if (!slug) {
        setError('No post slug provided');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        const postData = await getBlogPostBySlug(slug);
        setPost(postData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load post');
        setPost(null);
      } finally {
        setLoading(false);
      }
    };

    loadPost();
  }, [slug]);

  if (loading) {
    return (
      <div className="container">
        <BlogHeader />
        <main className="main-content">
          <div className="loading">Loading post...</div>
        </main>
        <BlogFooter />
      </div>
    );
  }

  if (error) {
    return (
      <div className="container">
        <BlogHeader />
        <main className="main-content">
          <div className="error">Error: {error}</div>
        </main>
        <BlogFooter />
      </div>
    );
  }

  if (!post) {
    return (
      <div className="container">
        <BlogHeader />
        <main className="main-content">
          <div className="error">Post not found</div>
        </main>
        <BlogFooter />
      </div>
    );
  }

  return (
    <div className="container">
      <BlogHeader />
      <main className="main-content">
        <BlogPost post={post} />
      </main>
      <BlogFooter />
    </div>
  );
};

const HomePage: React.FC = () => {
  const [posts, setPosts] = useState<BlogPostListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadPosts() {
      try {
        const allPosts = await getBlogPosts();
        const postList = getBlogPostList(allPosts);
        setPosts(postList);
      } catch (err) {
        console.error('Failed to load posts:', err);
      } finally {
        setLoading(false);
      }
    }
    loadPosts();
  }, []);

  if (loading) {
    return (
      <div className="container">
        <BlogHeader />
        <main className="main-content">
          <div className="loading">Loading...</div>
        </main>
        <BlogFooter />
      </div>
    );
  }

  return (
    <div className="container">
      <BlogHeader />
      <main className="main-content">
        <BlogHome posts={posts} />
      </main>
      <BlogFooter />
    </div>
  );
};

const App: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/:slug" element={<PostPage />} />
      </Routes>
    </Router>
  );
};

export default App;