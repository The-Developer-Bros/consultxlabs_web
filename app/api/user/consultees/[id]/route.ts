import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: Request,
    params: { id: string }) {
    try {
        const user = await prisma.consulteeProfile.findUnique({
            where: {
                id: params.id,
            },
        });

        NextResponse.json({ data: user }, { status: 200 });
    } catch (error) {
        console.error("Error getting user:", error);
        NextResponse.error();
    }
}

export async function POST(req: Request,
    params: { id: string }) {
    try {
        const { classes, subscriptions, webinars } = await req.json();

        const createdUser = await prisma.consulteeProfile.create({
            data: {
                id: params.id,
                classes,
                subscriptions,
                webinars,
                onlineStatus: false,
                user: {
                    connect: {
                        id: params.id,
                    },
                },
            },
        });

        NextResponse.json(createdUser);
    } catch (error) {
        console.error("Error creating user:", error);
        NextResponse.error();
    }
}

export async function PUT(req: Request,
    params: { id: string }) {
    try {
        const { classes, subscriptions, webinars } = await req.json();

        const updatedUser = await prisma.consulteeProfile.update({
            where: {
                id: params.id,
            },
            data: {
                id: params.id,
                classes,
                subscriptions,
                webinars,
            },
        });

        NextResponse.json(updatedUser);
    } catch (error) {
        console.error("Error updating user:", error);
        NextResponse.error();
    }
}

export async function DELETE(req: Request,
    params: { id: string }) {
    try {
        const deletedUser = await prisma.consulteeProfile.delete({
            where: {
                id: params.id,
            },
        });

        NextResponse.json(deletedUser);
    } catch (error) {
        console.error("Error deleting user:", error);
        NextResponse.error();
    }
}