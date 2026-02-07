import { useState } from 'react'
import NikiProfile from './NikiProfile'
import OtherProfile from './OtherProfile' // 1. Import your new second component
import './App.css'

function App() {
  // Use state to track which "page" we are on
  const [view, setView] = useState('niki');

  return (
    <div className="app-container">
      <nav>
        <button onClick={() => setView('niki')}>Show Niki</button>
        <button onClick={() => setView('other')}>Show Other</button>
      </nav>

      <hr />

      <div className="content-area">
        {/* Conditional Rendering: If view is 'niki', show NikiProfile, else show OtherProfile */}
        {view === 'niki' ? (
          <NikiProfile />
        ) : (
          <OtherProfile />
        )}
      </div>
    </div>
  )
}

export default App