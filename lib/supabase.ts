import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

const supabase = createClient(supabaseUrl, supabaseKey);

const fetchImagesFromSupabaseStorage = async (bucket: string, path: string) => {
    try {
        const { data, error } = await supabase.storage.from(bucket).list(path, {
            limit: 10,
            offset: 0,
            sortBy: { column: "created_at", order: "desc" },
        });

        if (error) {
            console.error("Error fetching images:", error);
            return [];
        }

        return data.map((file) => {
            const {
                data: { publicUrl },
            } = supabase.storage.from(bucket).getPublicUrl(`${path}/${file.name}`);
            return { ...file, url: publicUrl };
        });
    } catch (error) {
        console.log("error", error);
        return [];
    }
};

export default supabase;
export { fetchImagesFromSupabaseStorage };