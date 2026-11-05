import { ArrayMaxSize, IsArray, IsString, Matches } from 'class-validator';

export class ReceiptLookupDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @Matches(/\S/, { each: true })
  op_ids!: string[];
}
