/**
 * Rajoitettu rinnakkaisuus (arkkitehtuuri §43).
 *
 * Havaintolista tarvitsee **yhden upstream-kutsun per havainto** (detalji:
 * bounding boxit ja confidence) ja yhden per kuva (presigned-URL). Ilman
 * rajoitusta 12 havaintoa tekisi 24 rinnakkaista kutsua kerralla: se olisi
 * kohtelias tapa kaataa lähdepalvelun 50 req/s -throttlaus ja tuottaisi
 * osittaisia epäonnistumisia. Siksi kutsut tehdään pienissä erissä.
 *
 * Järjestys säilyy (tulos[i] vastaa aina items[i]:tä), joten kutsuja voi
 * yhdistää tulokset suoraan syötteeseen.
 */

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const concurrency = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      results[index] = await mapper(item, index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
