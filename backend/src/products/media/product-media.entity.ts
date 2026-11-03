import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('product_media')
export class ProductMedia {
    @PrimaryColumn('text') id: string;
    @Index() @Column('text') ownerId: string;
    @Index() @Column('text', { nullable: true }) productId: string | null;
    @Column('integer', { default: 0 }) position: number;
    @Column('text') originalName: string;
    @Column('text') kind: 'image' | 'video';
    @Column('text') mimeType: string;
    @Column('integer') size: number;
    @Column('integer') reservedBytes: number;
    @Column('text') status: 'reserved' | 'uploading' | 'ready' | 'failed' | 'deleted';
    @Column('text', { nullable: true }) error: string | null;
    @Column('integer') expiresAt: number;
    @Column('integer', { default: 0 }) width: number;
    @Column('integer', { default: 0 }) height: number;
    @Column('float', { default: 0 }) duration: number;
}
