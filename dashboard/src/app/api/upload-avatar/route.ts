import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { supabaseAdmin } from '@/lib/supabase';
import { v4 as uuidv4 } from 'uuid';
import { apiError } from '@/lib/api-response';
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import {
  ALLOWED_AVATAR_EXTENSIONS,
  ALLOWED_AVATAR_MIME_TYPES,
  detectImageType,
} from "@/lib/image-magic-bytes";

const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimitError = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "upload_avatar_post",
      userId,
      ...RATE_LIMIT_PRESETS.uploadWrite,
    });
    if (rateLimitError) {
      return rateLimitError;
    }

    if (!supabaseAdmin) {
      return NextResponse.json(
        { success: false, error: 'Supabase admin client not initialized' },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const file = formData.get('file');

    // A form field can be a string instead of a File (e.g. a forged or
    // malformed multipart body). The previous `as File` cast hid that: a
    // string passed the truthiness check, then `file.size` / `file.type`
    // were undefined and the route crashed downstream with an unclear
    // 500. Validate the real type the way the avatar-crop route does and
    // return a clear 400 instead.
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_AVATAR_SIZE_BYTES) {
      return NextResponse.json(
        { success: false, error: 'Avatar file is too large' },
        { status: 413 }
      );
    }

    const fileExt = file.name.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED_AVATAR_EXTENSIONS.has(fileExt)) {
      return NextResponse.json(
        { success: false, error: 'Unsupported avatar file extension' },
        { status: 400 }
      );
    }

    if (!ALLOWED_AVATAR_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { success: false, error: 'Unsupported avatar file type' },
        { status: 400 }
      );
    }

    // Read file buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Magic-byte sniff: filename and Content-Type can both be forged
    // (the client picks both). The actual byte prefix is the only
    // confirmation that the upload is really an image of the claimed
    // type. Without this, an attacker can serve polyglot HTML/JS bytes
    // that the dashboard's avatar `<img>` tag fetches and the browser
    // sniffs as HTML. We also pin the stored Content-Type to whatever
    // matches the magic so a forged claim of "image/gif" can't be
    // served back as gif when the bytes are something else.
    const detected = detectImageType(buffer);
    if (!detected) {
      return NextResponse.json(
        { success: false, error: 'Unsupported avatar file type' },
        { status: 400 }
      );
    }

    // Ensure bucket exists
    const { data: buckets } = await supabaseAdmin.storage.listBuckets();
    if (!buckets?.some(b => b.name === 'avatars')) {
      await supabaseAdmin.storage.createBucket('avatars', { public: true });
    }

    const fileName = `${uuidv4()}.${detected.extension}`;
    const filePath = `${fileName}`;

    const { error } = await supabaseAdmin.storage
      .from('avatars')
      .upload(filePath, buffer, {
        // Trust the magic-byte sniff over the client-supplied file.type.
        contentType: detected.mimeType,
        upsert: false,
      });

    if (error) {
      throw error;
    }

    const { data: publicUrlData } = supabaseAdmin.storage
      .from('avatars')
      .getPublicUrl(filePath);

    return NextResponse.json({
      success: true,
      url: publicUrlData.publicUrl,
    });
  } catch (error: unknown) {
    return apiError('Failed to upload avatar', 500, {
      failureType: 'upload_avatar_failed',
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
