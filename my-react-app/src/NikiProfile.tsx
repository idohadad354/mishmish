// NikiProfile.jsx
import { useState } from 'react'
import './NikiProfile.css'
import nikiImage from './assets/niki.webp'

function NikiProfile() {
  const [showProfile, setShowProfile] = useState(false)

  return (
    <section className="niki-profile">
      <div className="niki-card">
        <header className="niki-header">
          <div className="niki-avatar-wrap">
            <img className="niki-avatar" src={nikiImage} alt="Niki smiling" />
            <span className="niki-status">Available</span>
          </div>

          <div className="niki-title">
            <p className="niki-eyebrow">Creative Profile</p>
            <h1>Hey, I&apos;m Niki</h1>
            <p className="niki-subtitle">
              Portrait photographer who chases warm light, slow mornings, and
              good coffee.
            </p>
          </div>
        </header>

        <div className="niki-meta">
          <span className="niki-chip">Tel Aviv, Israel</span>
          <span className="niki-chip">Freelance</span>
          <span className="niki-chip">Next trip: Barcelona</span>
        </div>

        <div className="niki-stats">
          <div>
            <p className="niki-stat-number">128</p>
            <p className="niki-stat-label">Sessions</p>
          </div>
          <div>
            <p className="niki-stat-number">4.9</p>
            <p className="niki-stat-label">Rating</p>
          </div>
          <div>
            <p className="niki-stat-number">06</p>
            <p className="niki-stat-label">Years</p>
          </div>
        </div>

        <div className="niki-actions">
          <button
            className="niki-btn niki-btn-primary"
            onClick={() => setShowProfile(true)}
          >
            View Profile
          </button>
          <a
            className="niki-btn niki-btn-ghost"
            href="https://www.youtube.com/watch?v=11GKqZPi41s"
            target="_blank"
            rel="noreferrer"
          >
            Click me
          </a>
          <a
            className="niki-btn niki-btn-ghost"
            href="https://www.youtube.com/watch?v=xvFZjo5PgG0"
            target="_blank"
            rel="noreferrer"
          >
            fat lady chick for free
          </a>
        </div>

        {showProfile && (
          <div className="niki-profile-panel">
            <div className="niki-profile-image">
              <img src={nikiImage} alt="Niki portrait" />
            </div>
            <div className="niki-profile-copy">
              <h2>Profile</h2>
              <p>
                Niki is a portrait photographer focused on natural light,
                story-driven sessions, and warm, editorial palettes.
              </p>
              <div className="niki-profile-tags">
                <span>Portraits</span>
                <span>Editorial</span>
                <span>Film + Digital</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default NikiProfile
