import { StaticImport } from "next/dist/shared/lib/get-img-props";
import Image from "next/image"; // Ensure you have the correct import for the Image component

function renderImage(
  images: string | any[],
  index: number,
  placeholderUrl: string | StaticImport,
  width = 550,
  height = 310,
  className = "mx-auto aspect-video overflow-hidden rounded-xl object-cover object-center sm:w-full lg:order-last"
) {
  if (images.length > index && images[index].url) {
    return (
      <Image
        key={images[index].id}
        src={images[index].url}
        width={width}
        height={height}
        alt={images[index].name}
        className={className}
      />
    );
  } else {
    return (
      <Image
        key={`placeholder-${index}`}
        src={placeholderUrl}
        width={width}
        height={height}
        alt="Placeholder image"
        className={className}
      />
    );
  }
}

export default renderImage;
