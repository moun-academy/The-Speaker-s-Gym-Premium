// Service Worker for The Speaker's Gym
const CACHE_NAME = 'speakers-gym-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Motivational messages for notifications
const MESSAGES = [
  "Time to flex your speaking muscles!",
  "Your voice is waiting to be heard. Let's practice!",
  "A quick speech a day keeps stage fright away!",
  "Ready to build your speaking confidence?",
  "Your daily speaking workout awaits!",
  "Just 2 minutes of practice makes a difference!",
  "Champions practice daily. Your turn!"
];

// Install event - cache assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.url.includes('/api/')) {
    return;
  }
  event.respondWith(
    caches.match(event.request)
      .then((response) => response || fetch(event.request))
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow('/');
        }
      })
  );
});

// IndexedDB helper functions for service worker
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('SpeakersGymDB', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('stats')) {
        db.createObjectStore('stats', { keyPath: 'key' });
      }
    };
  });
}

function getFromDB(storeName, key) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result?.value);
    });
  });
}

function saveToDB(storeName, key, value) {
  return openDB().then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put({ key, value });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  });
}

// Check if notification should be sent
async function shouldSendNotification() {
  try {
    const settings = await getFromDB('settings', 'notifications');
    if (!settings || !settings.enabled) return false;

    const stats = await getFromDB('stats', 'daily');
    const today = new Date().toDateString();

    // Don't notify if already practiced today
    if (stats && stats.lastDate === today && stats.todaySpeeches > 0) {
      return false;
    }

    // Don't notify if already sent today
    if (settings.lastNotificationDate === today) {
      return false;
    }

    // Check if it's past the scheduled time
    const now = new Date();
    const [targetHours, targetMinutes] = settings.time.split(':').map(Number);
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();

    const isPastTime = currentHours > targetHours ||
      (currentHours === targetHours && currentMinutes >= targetMinutes);

    return isPastTime;
  } catch (e) {
    console.error('Error checking notification status:', e);
    return false;
  }
}

// Send the daily reminder notification
async function sendDailyReminder() {
  const shouldSend = await shouldSendNotification();
  if (!shouldSend) return;

  const message = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];

  await self.registration.showNotification("The Speaker's Gym", {
    body: message,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'daily-reminder',
    vibrate: [200, 100, 200],
    requireInteraction: true,
    actions: [
      { action: 'practice', title: 'Practice Now' }
    ]
  });

  // Mark as sent today
  try {
    const settings = await getFromDB('settings', 'notifications');
    if (settings) {
      settings.lastNotificationDate = new Date().toDateString();
      await saveToDB('settings', 'notifications', settings);
    }
  } catch (e) {
    console.error('Error updating notification date:', e);
  }
}

// Periodic Background Sync - for scheduled notifications
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'daily-reminder-sync') {
    event.waitUntil(sendDailyReminder());
  }
});

// Regular sync event (fallback)
self.addEventListener('sync', (event) => {
  if (event.tag === 'daily-reminder') {
    event.waitUntil(sendDailyReminder());
  }
});

// Handle messages from main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = event.data;
    self.registration.showNotification(title, {
      body: body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: tag || 'daily-reminder',
      vibrate: [200, 100, 200],
      requireInteraction: true
    });
  }

  if (event.data && event.data.type === 'CHECK_REMINDER') {
    sendDailyReminder();
  }
});
