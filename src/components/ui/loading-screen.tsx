export function LoadingScreen() {
  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center z-[100]">
      {/*
        The video has a white background with dark cube lines.
        - filter: invert(1) flips white→black and dark→light
        - The black then matches our #0a0a0a background seamlessly
        - The cube lines become light/accent-colored
        - filter also applies hue-rotate to tint the inverted cube toward our accent blue
        - mix-blend-mode: screen makes the remaining pure-black areas fully transparent
      */}
      <video
        autoPlay
        loop
        muted
        playsInline
        src="/loading.mp4"
        style={{
          width: 150,
          height: 150,
          filter: 'invert(1) hue-rotate(200deg) brightness(1.5)',
          mixBlendMode: 'screen',
        }}
      />
    </div>
  );
}
