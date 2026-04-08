'use client';

export default function PrivacyChoicesButton() {
  return (
    <button
      onClick={() => {
        localStorage.removeItem('waaiio_cookie_consent');
        window.location.reload();
      }}
      className="text-sm text-gray-400 hover:text-white transition"
    >
      Your Privacy Choices
    </button>
  );
}
