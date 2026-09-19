export default function NoAccessPage() {
  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <h1
          style={{ fontFamily: 'VT323, monospace' }}
          className="text-4xl text-[#FF6600] mb-4"
        >
          NO ACCESS
        </h1>
        <p className="text-gray-400 text-lg">
          You don&apos;t have access to Homestead.
        </p>
        <p className="text-gray-600 text-sm mt-4">
          Ask the owner to add you as a guest.
        </p>
      </div>
    </div>
  );
}
