import { useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Catalog from './pages/Catalog';
import Providers from './pages/Providers';
import Cost from './pages/Cost';
import Balances from './pages/Balances';
import Audit from './pages/Audit';

function Nav() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-4 py-2 rounded text-sm font-medium transition-colors ${
      isActive ? 'bg-indigo-700 text-white' : 'text-indigo-100 hover:bg-indigo-600'
    }`;

  return (
    <nav className="bg-indigo-800 text-white px-6 py-3 flex items-center gap-2">
      <span className="font-bold text-lg mr-6">⚓ Quartermaster</span>
      <NavLink to="/catalog" className={linkClass}>Catalog</NavLink>
      <NavLink to="/providers" className={linkClass}>Providers & Keys</NavLink>
      <NavLink to="/cost" className={linkClass}>Cost</NavLink>
      <NavLink to="/balances" className={linkClass}>Balances</NavLink>
      <NavLink to="/audit" className={linkClass}>Audit</NavLink>
    </nav>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(() => {
    // Check if we already have a valid session (cookie present)
    return document.cookie.includes('qm_token');
  });

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col">
        <Nav />
        <main className="flex-1 p-6 max-w-7xl mx-auto w-full">
          <Routes>
            <Route path="/" element={<Navigate to="/catalog" replace />} />
            <Route path="/catalog" element={<Catalog />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/cost" element={<Cost />} />
            <Route path="/balances" element={<Balances />} />
            <Route path="/audit" element={<Audit />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
