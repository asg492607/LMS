import React, { useEffect, useState } from 'react';
import AuthDialog from './AuthDialog.jsx';
import AdminDashboard from './AdminDashboard.jsx';
import RoleDashboard from './RoleDashboard.jsx';
import { supabase } from './supabase.js';

const slides = [
  {
    eyebrow: 'The University for',
    title: 'Holistic Development',
    description: 'One connected place for your classes, ideas, and next big achievement.',
    image: '/assets/hero-holistic.png',
    alt: 'MIT ADT students celebrating together on campus',
    tag: 'LEARN • CREATE • GROW',
  },
  {
    eyebrow: 'Curiosity in motion',
    title: 'A future you can build',
    description: 'Find your course materials, collaborate with your class, and keep moving forward.',
    image: '/assets/hero-engineering.png',
    alt: 'Students learning and training together at MIT ADT',
    tag: 'YOUR CAMPUS, ONLINE',
  },
  {
    eyebrow: 'Learning for life',
    title: 'Ideas become impact',
    description: 'Your learning journey continues here, wherever the day takes you.',
    image: '/assets/hero-careers.png',
    alt: 'A student reading in a university library',
    tag: 'MIT ADT LEARNING HUB',
  },
  {
    eyebrow: 'From campus to career',
    title: 'Make your next move',
    description: 'Stay up to date with learning resources, announcements, and opportunities.',
    image: '/assets/hero-university.png',
    alt: 'MIT ADT graduates celebrating together',
    tag: 'ALL YOUR LEARNING, ONE PLACE',
  },
];

const quickLinks = [
  {
    number: '01',
    title: 'My courses',
    text: 'Pick up where you left off and jump into this semester’s course spaces.',
    icon: 'book',
    href: '#student-portal',
  },
  {
    number: '02',
    title: 'Learning resources',
    text: 'Find lecture notes, reading lists, assignments, and recorded sessions.',
    icon: 'files',
    href: '#student-portal',
  },
  {
    number: '03',
    title: 'Campus updates',
    text: 'Keep up with important academic notices and what’s happening on campus.',
    icon: 'calendar',
    href: '#updates',
  },
];

function Icon({ name, size = 20 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  if (name === 'search') return <svg {...common}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>;
  if (name === 'book') return <svg {...common}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21z" /><path d="M4 5.5v13A2.5 2.5 0 0 1 6.5 16H20M8 7h8M8 10h6" /></svg>;
  if (name === 'files') return <svg {...common}><path d="M8 3h8l4 4v13H8z" /><path d="M16 3v5h4M5 7H4v14h12v-1M11 12h6M11 16h6" /></svg>;
  if (name === 'calendar') return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" /></svg>;
  if (name === 'arrow') return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
  if (name === 'phone') return <svg {...common}><path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M10 17h4" /></svg>;
  if (name === 'chat') return <svg {...common}><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-4 2v-6.5A7.5 7.5 0 1 1 20 11.5Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></svg>;
  return null;
}

function decorateUser(user) {
  if (!user) return null;
  return {
    ...user,
    uid: user.id,
    displayName: user.user_metadata?.display_name || user.user_metadata?.full_name || user.email || '',
    emailVerified: Boolean(user.email_confirmed_at || user.confirmed_at),
    mustChangePassword: user.app_metadata?.must_change_password === true,
  };
}

function Header({ onLogin }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="site-header">
      <div className="header-shell">
        <div className="header-top">
          <a className="brand" href="#home" aria-label="MIT ADT LMS home" onClick={closeMenu}>
            <img src="/assets/mit-adt-logo.png" alt="MIT ADT University Pune, India" />
          </a>

          <div className="header-tools">
            <div className="utility-links" aria-label="University links">
              <a href="#student-portal">Student portal</a>
              <a href="#faculty-portal">Faculty</a>
              <a href="#updates">Academic calendar</a>
              <a href="#support">Help &amp; support</a>
              <button className="utility-login" type="button" onClick={onLogin}>Log in <span aria-hidden="true">↗</span></button>
            </div>
            <div className="secondary-links" aria-label="Quick links">
              <a href="#updates">Careers</a>
              <a href="#updates">Alumni</a>
              <a href="#updates">Happenings</a>
              <a href="#courses">Programs</a>
              <a href="#updates">Research</a>
              <a href="#updates">Campus</a>
            </div>
            <div className="social-row">
              <a className="social" href="https://www.facebook.com/mitadtuniversity" aria-label="Facebook">f</a>
              <a className="social social-camera" href="https://www.instagram.com/mitadtuniversity/" aria-label="Instagram"><span /></a>
              <a className="social social-in" href="https://www.linkedin.com/school/mitadtuniversity/" aria-label="LinkedIn">in</a>
              <a className="social social-play" href="https://www.youtube.com/" aria-label="YouTube">▶</a>
              <button className="search-toggle" type="button" aria-label={searchOpen ? 'Close search' : 'Open search'} aria-expanded={searchOpen} onClick={() => setSearchOpen((open) => !open)}>
                <Icon name="search" size={32} />
              </button>
            </div>
          </div>

          <button className={`menu-toggle ${menuOpen ? 'is-open' : ''}`} type="button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
            <span /><span /><span />
          </button>
        </div>

        {searchOpen && (
          <form className="site-search" role="search" onSubmit={(event) => { event.preventDefault(); document.querySelector('#courses')?.scrollIntoView({ behavior: 'smooth' }); setSearchOpen(false); }}>
            <Icon name="search" />
            <input aria-label="Search the LMS" placeholder="Search courses and resources" autoFocus />
            <button type="submit">Search</button>
          </form>
        )}

        <nav className={`primary-nav ${menuOpen ? 'nav-open' : ''}`} aria-label="Main navigation">
          <a href="#home" onClick={closeMenu}>Home</a>
          <a href="#courses" onClick={closeMenu}>My learning</a>
          <a href="#student-portal" onClick={closeMenu}>Students</a>
          <a href="#faculty-portal" onClick={closeMenu}>Faculty</a>
          <a href="#updates" onClick={closeMenu}>Announcements</a>
          <a href="#support" onClick={closeMenu}>Support</a>
        </nav>
      </div>
    </header>
  );
}

function AnnouncementBar() {
  return (
    <div className="announcement" id="updates">
      <span className="announcement-label"><span className="live-dot" /> LMS NOTICE</span>
      <div className="announcement-copy">
        <span>Welcome to the MIT ADT Learning Management System.</span>
        <a href="#student-portal">Access your courses <Icon name="arrow" size={15} /></a>
        <span className="announcement-separator">•</span>
        <span>Stay on top of classes, resources, and campus updates.</span>
      </div>
      <a className="announcement-all" href="#updates">View all <Icon name="arrow" size={15} /></a>
    </div>
  );
}

function Hero({ onLogin }) {
  const [activeSlide, setActiveSlide] = useState(0);
  const slide = slides[activeSlide];

  useEffect(() => {
    const timer = window.setInterval(() => setActiveSlide((current) => (current + 1) % slides.length), 9000);
    return () => window.clearInterval(timer);
  }, []);

  const goTo = (direction) => setActiveSlide((current) => (current + direction + slides.length) % slides.length);

  return (
    <section className="hero-wrap" id="home" aria-label="MIT ADT LMS introduction">
      <div className="hero-frame">
        <div className="hero-card" key={activeSlide}>
          <div className="hero-image-wrap" aria-hidden="true">
            <img className="hero-image" src={slide.image} alt="" />
          </div>
          <div className="hero-copy">
            <div className="hero-eyebrow"><span /> {slide.eyebrow}</div>
            <h1>{slide.title}</h1>
            <p>{slide.description}</p>
            <div className="hero-actions">
              <a className="button button-light" href="#courses">Explore learning <Icon name="arrow" size={18} /></a>
              <button className="hero-login" type="button" onClick={onLogin}>Go to my LMS <span aria-hidden="true">↗</span></button>
            </div>
          </div>
          <div className="hero-caption"><span className="caption-line" />{slide.tag}</div>
        </div>
        <div className="hero-dots" aria-label="Choose a featured slide">
          {slides.map((item, index) => (
            <button key={item.title} type="button" className={index === activeSlide ? 'active' : ''} aria-label={`Show slide ${index + 1}: ${item.title}`} aria-current={index === activeSlide ? 'true' : undefined} onClick={() => setActiveSlide(index)} />
          ))}
        </div>
        <div className="hero-controls">
          <button type="button" aria-label="Previous featured slide" onClick={() => goTo(-1)}><span>‹</span></button>
          <button type="button" aria-label="Next featured slide" onClick={() => goTo(1)}><span>›</span></button>
        </div>
      </div>
      <div className="hero-note"><span className="note-sparkle">✳</span><span>Your campus. Your classes. All in one place.</span><a href="#courses">Start learning <Icon name="arrow" size={15} /></a></div>
    </section>
  );
}

function QuickAccess() {
  return (
    <section className="quick-section" id="courses">
      <div className="section-heading">
        <div>
          <p className="section-kicker">A better way to learn</p>
          <h2>Your learning, <span>all in one place.</span></h2>
        </div>
        <p className="section-intro">Everything you need to stay connected to your classes and campus, right here in your learning hub.</p>
      </div>

      <div className="quick-grid">
        {quickLinks.map((link) => (
          <a className="quick-card" href={link.href} key={link.number}>
            <div className="card-topline"><span className="card-number">{link.number}</span><span className="card-icon"><Icon name={link.icon} size={23} /></span></div>
            <h3>{link.title}</h3>
            <p>{link.text}</p>
            <span className="card-link">Explore <Icon name="arrow" size={16} /></span>
          </a>
        ))}
      </div>
    </section>
  );
}

function PortalSection({ onLogin }) {
  return (
    <section className="portal-section" id="student-portal">
      <div className="portal-copy">
        <p className="section-kicker">Welcome to your campus</p>
        <h2>Ready for what’s next?</h2>
        <p>Sign in to see your courses, class materials, assignments, and more.</p>
      </div>
      <div className="portal-actions">
        <button className="portal-link" type="button" onClick={onLogin}><span className="portal-icon"><Icon name="book" size={20} /></span><span><strong>Student login</strong><small>Open your learning dashboard</small></span><Icon name="arrow" size={18} /></button>
        <button className="portal-link" type="button" onClick={onLogin} id="faculty-portal"><span className="portal-icon"><Icon name="files" size={20} /></span><span><strong>Faculty login</strong><small>Manage courses and resources</small></span><Icon name="arrow" size={18} /></button>
      </div>
    </section>
  );
}

function SupportWidget({ onLogin }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div className="support-widget" id="support">
        {open && <div className="support-message"><button type="button" aria-label="Dismiss help message" onClick={() => setOpen(false)}>×</button><span className="support-welcome">Hello there 👋</span><span>Need a hand finding your way around the LMS?</span><a href="mailto:lms.support@mituniversity.edu.in">Talk to our support team <Icon name="arrow" size={14} /></a></div>}
        <button className="support-button" type="button" aria-label={open ? 'Hide LMS support' : 'Show LMS support'} onClick={() => setOpen((value) => !value)}><Icon name="chat" size={22} /></button>
      </div>
      <div className="floating-actions">
        <a href="mailto:lms.support@mituniversity.edu.in" className="floating-help"><Icon name="phone" size={19} /> Contact support</a>
        <button type="button" onClick={onLogin} className="floating-login"><span className="login-check" aria-hidden="true">↗</span> Log in to LMS</button>
      </div>
    </>
  );
}

export default function App() {
  const [loginOpen, setLoginOpen] = useState(false);
  const [user, setUser] = useState(null);
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [adminView, setAdminView] = useState(false);
  const [portalView, setPortalView] = useState(false);
  const [roleAssignments, setRoleAssignments] = useState([]);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    const resetForSignedOut = () => {
      setPlatformAdmin(false);
      setAdminView(false);
      setPortalView(false);
      setRoleAssignments([]);
    };
    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setUser(decorateUser(data.session?.user));
        if (!data.session?.user) resetForSignedOut();
      }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = decorateUser(session?.user);
      setUser(currentUser);
      if (!currentUser) resetForSignedOut();
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <>
      {adminView && platformAdmin && user ? (
        <AdminDashboard user={user} onBack={() => setAdminView(false)} />
      ) : portalView && user ? (
        <RoleDashboard user={user} roleAssignments={roleAssignments} onBack={() => setPortalView(false)} />
      ) : (
        <>
          <Header onLogin={() => setLoginOpen(true)} />
          <AnnouncementBar />
          <main>
            <Hero onLogin={() => setLoginOpen(true)} />
            <QuickAccess />
            <PortalSection onLogin={() => setLoginOpen(true)} />
          </main>
          <footer className="site-footer"><a className="footer-brand" href="#home"><img src="/assets/mit-adt-logo.png" alt="MIT ADT University" /></a><p>MIT ADT LMS <span>•</span> Learn without limits</p><span className="footer-note">© 2026 MIT ADT University, Pune</span></footer>
          <SupportWidget onLogin={() => setLoginOpen(true)} />
        </>
      )}
      {loginOpen && <AuthDialog
        user={user}
        isPlatformAdmin={platformAdmin}
        onAdminStatus={setPlatformAdmin}
        onRoleAssignments={setRoleAssignments}
        roleAssignments={roleAssignments}
        onOpenAdmin={() => { setAdminView(true); setPortalView(false); setLoginOpen(false); }}
        onOpenPortal={() => { setPortalView(true); setAdminView(false); setLoginOpen(false); }}
        onClose={() => setLoginOpen(false)}
      />}
    </>
  );
}
