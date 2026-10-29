// The site root: a pointer to the secret link. The dashboard lives at /hq/<secret>.

/** No secret in the URL: nothing to show. */
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <p className="text-muted-foreground max-w-md text-center text-[13px] leading-[1.6]">
        Open the link you were given. This page holds nothing on its own.
      </p>
    </main>
  )
}
