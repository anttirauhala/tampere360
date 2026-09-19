import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';

import { Layout } from './components/Layout';
import { CategoryPage } from './pages/CategoryPage';
import { NowPage } from './pages/NowPage';
import { SourcesPage } from './pages/SourcesPage';

// MapLibre GL JS on raskas (~1,3 MB) → ladataan vain kun karttasivu avataan.
const MapPage = lazy(() =>
  import('./pages/MapPage').then((module) => ({ default: module.MapPage })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

function NotFound() {
  return (
    <section className="page">
      <h1 className="page__title">Sivua ei löytynyt</h1>
      <p className="page__lead">
        <Link to="/">Palaa tilannekuvaan</Link>
      </p>
    </section>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<NowPage />} />
            <Route
              path="kartta"
              element={
                <Suspense fallback={<p className="state state--loading">Ladataan karttaa…</p>}>
                  <MapPage />
                </Suspense>
              }
            />
            <Route path="liikenne" element={<CategoryPage category="TRAFFIC" />} />
            <Route path="saa" element={<CategoryPage category="WEATHER" />} />
            <Route path="poliisi" element={<CategoryPage category="POLICE" />} />
            <Route path="joukkoliikenne" element={<CategoryPage category="PUBLIC_TRANSPORT" />} />
            <Route path="lahteet" element={<SourcesPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
