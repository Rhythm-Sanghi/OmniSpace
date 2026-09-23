function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getDeviceId(): string {
  if (typeof window === 'undefined') {
    return 'server-dummy-id';
  }

  const urlParams = new URLSearchParams(window.location.search);
  const isDev = urlParams.get('dev') === 'true' || urlParams.get('devDeviceId') !== null;
  const devOverrideId = urlParams.get('devDeviceId');

  if (isDev) {
    if (devOverrideId) {
      sessionStorage.setItem('omni_dev_device_id', devOverrideId);
      return devOverrideId;
    }
    let devId = sessionStorage.getItem('omni_dev_device_id');
    if (!devId) {
      devId = `dev-device-${generateUUID()}`;
      sessionStorage.setItem('omni_dev_device_id', devId);
    }
    return devId;
  }

  let deviceId = localStorage.getItem('omni_device_id');
  if (!deviceId) {
    deviceId = `device-${generateUUID()}`;
    localStorage.setItem('omni_device_id', deviceId);
  }
  return deviceId;
}
