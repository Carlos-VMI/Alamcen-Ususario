import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';

export function useLiveQuery(factory, deps = [], initialValue = []) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    const subscription = liveQuery(factory).subscribe({
      next: setValue,
      error: console.error
    });

    return () => subscription.unsubscribe();
  }, deps);

  return value;
}
