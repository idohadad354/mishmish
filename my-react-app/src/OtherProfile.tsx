import React, { useState } from 'react';

const OtherProfile: React.FC = () => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div 
      style={{
        ...styles.card,
        transform: isHovered ? 'scale(1.05) rotateY(10deg)' : 'scale(1) rotateY(0)',
        boxShadow: isHovered ? '0 30px 60px rgba(100, 108, 255, 0.4)' : '0 10px 30px rgba(0,0,0,0.3)',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Floating Sparkles (purely for the 'wow' factor) */}
      <div style={styles.sparkleOne}>✨</div>
      <div style={styles.sparkleTwo}>✨</div>

      <div style={styles.imageContainer}>
        <img 
          src="https://upload.wikimedia.org/wikipedia/commons/5/56/Donald_Trump_official_portrait.jpg" 
          alt="Donald Trump" 
          style={{
            ...styles.image,
            borderColor: isHovered ? '#ff0055' : '#646cff'
          }} 
        />
      </div>

      <h2 style={{
        ...styles.name,
        background: isHovered 
          ? 'linear-gradient(to right, #ff0055, #646cff, #00ffcc)' 
          : '#fff',
        WebkitBackgroundClip: isHovered ? 'text' : 'none',
        WebkitTextFillColor: isHovered ? 'transparent' : 'white'
      }}>
        Donald Trump
      </h2>

      <p style={styles.bio}>
        Experience the next generation of profile design with 3D interactions and glassmorphism.
      </p>

      {/* The Liquid Glow Button */}
      <button 
        style={{
          ...styles.button,
          boxShadow: isHovered ? '0 0 20px #646cff' : 'none'
        }}
      >
        <span style={styles.buttonText}>GET STARTED</span>
      </button>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  card: {
    background: 'rgba(255, 255, 255, 0.05)',
    backdropFilter: 'blur(15px)',
    borderRadius: '30px',
    padding: '50px 30px',
    textAlign: 'center',
    width: '320px',
    margin: '50px auto',
    color: '#fff',
    fontFamily: '"Inter", sans-serif',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    transition: 'all 0.5s cubic-bezier(0.23, 1, 0.32, 1)',
    position: 'relative',
    overflow: 'visible'
  },
  imageContainer: {
    marginBottom: '20px',
    zIndex: 2
  },
  image: {
    width: '150px',
    height: '150px',
    borderRadius: '50%',
    objectFit: 'cover',
    border: '4px solid #646cff',
    transition: 'border-color 0.3s ease'
  },
  name: {
    fontSize: '2rem',
    fontWeight: '900',
    margin: '10px 0',
    transition: 'all 0.3s ease'
  },
  bio: {
    fontSize: '0.95rem',
    opacity: 0.8,
    lineHeight: '1.6',
    marginBottom: '30px'
  },
  button: {
    position: 'relative',
    padding: '15px 35px',
    background: '#1a1a1a',
    border: '2px solid #646cff',
    borderRadius: '50px',
    color: '#fff',
    fontWeight: 'bold',
    cursor: 'pointer',
    overflow: 'hidden',
    transition: 'all 0.3s ease'
  },
  buttonText: {
    position: 'relative',
    zIndex: 1,
    letterSpacing: '2px'
  },
  sparkleOne: {
    position: 'absolute',
    top: '10px',
    left: '10px',
    fontSize: '20px',
    animation: 'float 3s infinite ease-in-out'
  },
  sparkleTwo: {
    position: 'absolute',
    bottom: '20px',
    right: '20px',
    fontSize: '20px',
    animation: 'float 4s infinite ease-in-out'
  }
};

export default OtherProfile;