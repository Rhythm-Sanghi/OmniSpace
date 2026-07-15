export function getDeviceId(): string {
  if (typeof window === 'undefined') {
    return 'server-dummy-id';
  }

  const urlParams = new URLSearchParams(window.location.search);
  const isDev = urlParams.get('dev') === 'true' || urlParams.get('devDeviceId') !== null;
  const devOverrideId = urlParams.get('devDeviceId');

  if (isDev) {
    if (devOverrideId) {
      sessionStorage.setItem('omni_device_id', devOverrideId);
      return devOverrideId;
    }
    let devId = sessionStorage.getItem('omni_device_id');
    if (!devId) {
      devId = `dev-device-${crypto.randomUUID()}`;
      sessionStorage.setItem('omni_device_id', devId);
    }
    return devId;
  }

  let deviceId = localStorage.getItem('omni_device_id');
  if (!deviceId) {
    deviceId = `device-${crypto.randomUUID()}`;
    localStorage.setItem('omni_device_id', deviceId);
  }
  return deviceId;
}
