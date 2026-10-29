// One verification in the Studio.
import { StudioView } from "@/components/verify/StudioView"

export default async function StudioPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params
  return <StudioView id={id} />
}
