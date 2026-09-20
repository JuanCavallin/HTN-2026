import { Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { GraphEditor } from './pages/GraphEditor';
import { Home } from './pages/Home';
import { RunDetail } from './pages/RunDetail';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/runs/:id" element={<RunDetail />} />
        <Route path="/graphs" element={<GraphEditor />} />
        <Route path="/graphs/:id" element={<GraphEditor />} />
      </Routes>
    </AppShell>
  );
}
